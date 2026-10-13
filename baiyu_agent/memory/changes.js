const { createHash } = require('crypto');
const { sessionState, currentConstraints } = require('./session-state');
const { stableJson } = require('../shared/runtime');

function scopedId(item) { return `scoped:${item.scope}:${item.key}`; }
function findTarget(manager, scoped, id, scope, relation) {
  const personal = manager.snapshot.memory.items.find(item => item.id === id);
  if (relation === 'exception' || scope === 'user') return personal;
  const local = scoped.find(item => scopedId(item) === id && (scope === 'any' || item.scope === scope));
  return scope === 'any' ? personal || local : local;
}
function applyMemoryChange(manager, args) {
  manager.refresh();
  const proposal = manager.proposal(args.proposalId);
  const fingerprint = stableJson(args), completed = manager.completedProposals.get(proposal.id);
  if (completed) {
    if (completed.fingerprint !== fingerprint) throw new Error('该记忆提案已执行，不能改用其他目标重复执行。');
    return { ...completed.result, replayed: true };
  }
  const { userId, requestId, sessionId, database, conversationStore } = manager.options;
  const { action, kind, value, sourceQuote, expiresAt, relation, all } = proposal;
  let scope = proposal.scope;
  if (scope === 'task' && action === 'upsert' && manager.interpretation.taskSourceQuote && !manager.taskStartedThisTurn) {
    throw new Error('请先 start_task 切换任务，再保存新任务条件，避免清掉刚保存的约束。');
  }
  if (expiresAt && expiresAt <= Date.now()) throw new Error('该记忆条件已经过期，请重新确认时间范围。');
  const scoped = currentConstraints(manager.state, requestId);
  let target;
  if (args.memoryId) {
    if (all) throw new Error('全部遗忘不能指定单个目标。');
    manager.requireObserved(args.memoryId);
    target = findTarget(manager, scoped, args.memoryId, scope, relation);
    if (!target) throw new Error('MEMORY_TARGET_NOT_FOUND');
    if (scope === 'any') scope = scoped.includes(target) ? target.scope : 'user';
    if (args.key && args.key !== target.key) throw new Error('修订已有条目不能同时改用新 key。');
  } else if (relation !== 'upsert' && !all) {
    throw new Error('请先 search_memory 确定目标 ID；同义表达可分页浏览，歧义时澄清。');
  }
  if (scope === 'user' && !userId) throw new Error('长期记忆需要登录；游客可使用会话范围。');
  if (relation === 'upsert' && !target && !manager.memoryReadScopes.has(scope)
    && (scope === 'user' ? manager.snapshot.memory.items.length : scoped.some(item => item.scope === scope))) {
    throw new Error('该范围已有记忆，请先 search_memory 读取候选；同义表达可能对应既有条目，不能直接重复新增。');
  }
  if (action === 'forget' && args.key) throw new Error('遗忘用已读取的 memoryId；不接受新 key。');
  if (relation === 'exception' && !['preference_negative', 'preference_constraints'].includes(target.kind)) {
    throw new Error('本轮例外只能覆盖明确的长期排除或约束条目。');
  }
  const source = { kind: 'user_message', quote: sourceQuote, requestId, sessionId,
    interpretation: { assertion: proposal.assertion, temporalScope: proposal.temporalScope, relation } };
  const input = { ...args, ...proposal };
  let receipt;
  if (scope === 'user') {
    let change;
    if (action === 'forget') change = { action, ids: all ? manager.snapshot.memory.items.map(item => item.id) : [target.id] };
    else {
      const identical = target || manager.snapshot.memory.items.find(item => item.kind === kind && item.value === value);
      const key = target ? target.key : identical?.key || args.key || `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
      if (!target && manager.snapshot.memory.items.some(item => item.key === key && item.id !== identical?.id)) {
        throw new Error('该 key 已存在不同记忆；请读取后明确修订，不能以新增覆盖。');
      }
      if (identical?.expiresAt !== (expiresAt || 0) && !target && identical) {
        throw new Error('既有记忆的期限不同，需要明确修订。');
      }
      change = { action, kind, key, value, source, expiresAt, memoryId: identical?.id };
    }
    const changeId = `${requestId}:${createHash('sha256').update(stableJson(input)).digest('hex')}`;
    receipt = database.applyAgentMemoryChange({ userId, sessionId, changeId,
      inputHash: manager.options.inputHash || '', expectedRevision: manager.snapshot.memory.revision, change });
    const destructive = receipt.changed > 0 && (action === 'forget' || Boolean(change.memoryId));
    manager.suppressHistory ||= destructive;
    manager.refresh();
    if (destructive) { manager.state = sessionState(conversationStore.snapshot(userId, sessionId).state);
      manager.state.task = manager.taskStartedThisTurn ? manager.interpretation.taskSourceQuote : ''; }
    receipt = { ...receipt, action, scope, key: change.key };
  } else {
    const next = sessionState(manager.state);
    const affected = action === 'forget'
      ? scoped.filter(item => item.scope === scope && (all || scopedId(item) === args.memoryId))
      : relation === 'upsert' && target && (target.value !== value || target.kind !== kind
        || target.expiresAt !== expiresAt || target.overridesMemoryId) ? [target] : [];
    next.constraints = next.constraints.filter(item => !affected.some(old => scopedId(old) === scopedId(item)));
    if (action === 'upsert') {
      const key = target ? target.key : args.key || `${kind}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`;
      const existing = next.constraints.find(item => item.key === key && item.scope === scope);
      if (existing && (existing.value !== value || existing.kind !== kind || existing.expiresAt !== expiresAt
        || existing.overridesMemoryId !== (relation === 'exception' ? target.id : undefined))) {
        throw new Error('该临时 key 已存在不同条件；请读取后明确修订。');
      }
      next.constraints = next.constraints.filter(item => item.key !== key || item.scope !== scope);
      if (next.constraints.length >= 64) throw new Error('会话约束数量已达到上限，请明确整理。');
      next.constraints.push({ key, value, sourceQuote, kind, scope, turnId: requestId, expiresAt,
        ...(relation === 'exception' ? { overridesMemoryId: target.id } : {}) });
    }
    const quarantine = Boolean(affected.length || (action === 'forget' && all));
    if (quarantine) {
      next.task = ''; next.openQuestions = [];
      next.resultRefs = next.resultRefs.map(({ artifactId, ...ref }) => ref);
      manager.suppressHistory = true;
    }
    receipt = manager.commitState(next, { quarantine, affected,
      receipt: manager.changeReceipt(input, scope, action === 'forget' ? affected.length : 1) });
  }
  manager.completedProposals.set(proposal.id, { fingerprint, result: receipt });
  manager.changed = true;
  return receipt;
}

module.exports = { applyMemoryChange };
