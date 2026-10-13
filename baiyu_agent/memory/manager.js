const { createHash } = require('crypto');
const { memorySearchTerms, scoreMemory, emptyUserMemory } = require('./user-memory');
const { sessionState, currentConstraints } = require('./session-state');
const { stableJson } = require('../shared/runtime');
const { memoryConfig, estimateTokens, truncateToTokens } = require('./memory');

const { applyMemoryChange } = require('./changes');

class MemoryManager {
  constructor(options) {
    this.options = options;
    this.snapshot = options.contextSnapshot || options.conversationStore.snapshot(options.userId, options.sessionId);
    this.state = sessionState(this.snapshot.state);
    this.state.constraints = currentConstraints(this.state, options.requestId);
    if (!this.state.task) this.state.task = String(options.message).slice(0, 400);
    this.interpretation = null;
    this.completedProposals = new Map();
    this.observedMemories = new Set();
    this.memoryReadScopes = new Set();
    this.taskStartedThisTurn = false;
    this.changed = false;
    this.contextVersion = 0;
  }
  get controlPending() { return !this.interpretation || Boolean(this.interpretation.clarification)
    || Boolean(this.interpretation.taskSourceQuote && !this.taskStartedThisTurn) || this.pendingProposals.length > 0; }
  get pendingProposals() { return (this.interpretation?.requests || []).filter(item => !this.completedProposals.has(item.id)); }
  setInterpretation(interpretation) { this.interpretation = Object.freeze({ ...interpretation, requests: Object.freeze([...interpretation.requests]) }); }
  proposal(id) {
    const proposal = this.interpretation?.requests.find(item => item.id === id);
    if (!proposal || this.interpretation.clarification) throw new Error('请先澄清记忆意图；不能执行未经本轮语义解释的记忆操作。');
    return proposal;
  }
  observeMemory(item) { this.observedMemories.add(item.id); return item; }
  requireObserved(id) {
    if (!this.observedMemories.has(id)) throw new Error('请先通过 search_memory 读取目标条目，再确定要修改或遗忘的 ID。');
  }
  refresh() {
    const { conversationStore, sessionId, userId } = this.options;
    const fresh = conversationStore.snapshot(userId, sessionId);
    const active = currentConstraints(this.state, this.options.requestId);
    const expired = active.length !== this.state.constraints.length;
    const memoryChanged = fresh.memory.items.length !== this.snapshot.memory.items.length
      || fresh.memory.items.some((item, index) => item.id !== this.snapshot.memory.items[index]?.id);
    const changed = expired || memoryChanged || fresh.memory.epoch !== this.snapshot.memory.epoch || fresh.memory.revision !== this.snapshot.memory.revision;
    this.state.constraints = active;
    if (changed) { this.contextVersion++; this.observedMemories.clear(); this.memoryReadScopes.clear(); }
    if (fresh.memory.epoch !== this.snapshot.memory.epoch) {
      this.state = sessionState(fresh.state);
      if (this.taskStartedThisTurn && this.interpretation?.taskSourceQuote) this.state.task = this.interpretation.taskSourceQuote;
    }
    this.snapshot = { ...fresh, state: this.state };
    return changed;
  }
  commitState(next, options = {}) {
    const { userId, sessionId, conversationStore } = this.options;
    const saved = conversationStore.saveState(userId, sessionId, next, this.snapshot.revision, this.snapshot.memory.epoch, options);
    this.state = saved.replayed ? sessionState(conversationStore.snapshot(userId, sessionId).state) : next;
    this.refresh();
    return saved.receipt || options.receipt?.result;
  }
  changeReceipt(args, scope, changed) {
    const changeId = `${this.options.requestId}:${createHash('sha256').update(stableJson(args)).digest('hex')}`;
    return { changeId,
      result: { status: 'memory_updated', changeId, action: args.action, scope, key: args.key, changed,
        inputHash: this.options.inputHash || '' } };
  }
  list(args = {}) {
    this.refresh();
    for (const scope of args.scope ? [args.scope] : ['turn', 'task', 'session', 'user']) this.memoryReadScopes.add(scope);
    const scoped = currentConstraints(this.state, this.options.requestId).map(item => ({ ...item,
      id: `scoped:${item.scope}:${item.key}`, source: { kind: 'user_message', quote: item.sourceQuote || item.value } }));
    let items = [...this.snapshot.memory.items.map(item => ({ ...item, scope: 'user' })), ...scoped]
      .filter(item => (!args.scope || item.scope === args.scope) && (!args.kind || item.kind === args.kind));
    if (args.memoryIds) items = items.filter(item => args.memoryIds.includes(item.id));
    if (args.query) {
      const terms = memorySearchTerms(args.query);
      items = items.map(item => ({ ...item, score: scoreMemory(item.value + ' ' + (item.source?.quote || ''), terms) }))
        .filter(item => item.score > 0).sort((a, b) => b.score - a.score);
    }
    const offset = args.offset || 0, limit = Math.min(12, args.limit || 8);
    const selected = items.slice(offset, offset + limit).map(({ id, key, kind, value, scope, expiresAt, source }) => {
      const quote = source?.quote || '';
      const excerpt = truncateToTokens(quote, 600);
      return { id, key, kind, value, scope, expiresAt, source: { kind: source?.kind || 'user_message', quote: excerpt,
        ...(excerpt !== quote ? { truncated: true } : {}) } };
    });
    // Choose the actual page before emitting its cursor; wire truncation must not skip unseen rows.
    const budget = memoryConfig().toolResultTokenBudget;
    while (selected.length > 1 && estimateTokens(JSON.stringify(selected)) > budget - 300) selected.pop();
    selected.forEach(item => this.observeMemory(item));
    return { items: selected, total: items.length, nextOffset: offset + selected.length < items.length ? offset + selected.length : null,
      revision: this.snapshot.memory.revision, mode: args.query ? 'keyword_candidates' : 'browse' };
  }
  search(query, limit = 3, { includeScoped = true, softOnly = false } = {}) {
    this.refresh();
    const terms = memorySearchTerms(query);
    const scoped = includeScoped ? currentConstraints(this.state, this.options.requestId).map(item => ({ ...item, id: `scoped:${item.scope}:${item.key}`, source: { kind: 'user_message', quote: item.sourceQuote || item.value }, scope: item.scope })) : [];
    return [...this.snapshot.memory.items.map(item => ({ ...item, scope: 'user' })), ...scoped]
      .filter(item => !softOnly || !['preference_negative', 'preference_constraints'].includes(item.kind))
      .map(item => ({ ...item, score: scoreMemory(item.value, terms) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(4, limit))
      .map(({ id, key, kind, value, source, expiresAt, scope }) => ({ id, key, kind, value, source, expiresAt, scope }));
  }
  view(query = this.options.message, { forRecommendation = false } = {}) {
    this.refresh();
    const store = emptyUserMemory();
    const items = this.snapshot.memory.items;
    const overrides = new Set(currentConstraints(this.state, this.options.requestId).map(item => item.overridesMemoryId).filter(Boolean));
    for (const item of items.filter(item => !overrides.has(item.id) && ['preference_negative', 'preference_constraints'].includes(item.kind))) {
      store.preferences[item.kind === 'preference_negative' ? 'negative' : 'constraints'].push(item.value);
    }
    let used = 0;
    const related = this.search(query, 4, { includeScoped: false, softOnly: true });
    const selected = forRecommendation
      ? [...new Map([...related.filter(item => item.kind === 'preference_positive'),
        ...items.filter(item => item.kind === 'preference_positive'), ...related].map(item => [item.id, item])).values()]
      : related;
    for (const item of selected.slice(0, 4)) {
      if (['preference_negative', 'preference_constraints'].includes(item.kind)) continue;
      const cost = estimateTokens(item.value);
      if (used + cost > memoryConfig().userStoreTokenBudget) continue;
      used += cost;
      if (item.kind === 'preference_positive') store.preferences.positive.push(item.value);
      else store.facts.push({ id: item.id, kind: item.kind, value: item.value, source: 'user_message' });
    }
    for (const item of currentConstraints(this.state, this.options.requestId)) {
      if (['fact', 'episode'].includes(item.kind)) store.facts.push({ kind: item.kind, value: item.value, source: 'user_message' });
      else store.preferences[item.kind === 'preference_negative' ? 'negative' : item.kind === 'preference_positive' ? 'positive' : 'constraints'].push(item.value);
    }
    return JSON.stringify(store);
  }
  history(query, sessionId, limit) {
    this.refresh();
    const { database, userId, conversationStore } = this.options;
    return userId ? database.searchAgentHistory(userId, query, sessionId, limit)
      : conversationStore.searchGuestHistory(this.options.sessionId, query, limit);
  }
  readHistory(args) {
    this.refresh();
    const { userId, database, conversationStore, sessionId } = this.options;
    if (args.artifactId) return userId ? database.readAgentContextArtifact(userId, args.artifactId, args.offset || 0) : { found: false };
    if (userId) return database.readAgentHistory(userId, args.eventId, args.offset || 0);
    const guest = conversationStore.guest(sessionId);
    const row = guest.history.find(item => item.id === args.eventId && item.id > (guest.historyFloorId || 0));
    const chars = [...String(row?.content || '')], end = Math.min(chars.length, (args.offset || 0) + 2400);
    return row ? { found: true, eventId: row.id, content: chars.slice(args.offset || 0, end).join(''), nextOffset: end < chars.length ? end : null } : { found: false };
  }
  apply(args) { return applyMemoryChange(this, args); }
  startTask({ sourceQuote }) {
    this.refresh();
    if (!sourceQuote?.trim() || !this.options.message.includes(sourceQuote)) throw new Error('任务切换需要本轮用户原文来源。');
    if (!this.interpretation || this.interpretation.clarification || sourceQuote !== this.interpretation.taskSourceQuote) {
      throw new Error('任务切换必须对应本轮完整消息解释中的明确切换要求。');
    }
    if (this.taskStartedThisTurn) return { status: 'task_started', scope: 'task', replayed: true };
    const next = sessionState(this.state);
    next.task = sourceQuote;
    next.constraints = next.constraints.filter(item => item.scope !== 'task');
    next.openQuestions = [];
    this.commitState(next);
    this.taskStartedThisTurn = true;
    this.changed = true;
    return { status: 'task_started', scope: 'task' };
  }
}

module.exports = { MemoryManager };
