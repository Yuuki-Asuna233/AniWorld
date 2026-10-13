const { randomUUID } = require('crypto');

function sessionState(raw) {
  let source = raw || {};
  if (typeof source === 'string') { try { source = JSON.parse(source); } catch (_) { source = {}; } }
  if (!source || typeof source !== 'object' || Array.isArray(source)) source = {};
  const now = Date.now();
  return { version: 1, task: String(source.task || '').slice(0, 400),
    constraints: (Array.isArray(source.constraints) ? source.constraints : []).filter(item =>
      item && typeof item.value === 'string' && (!item.expiresAt || item.expiresAt > now)).slice(-64),
    animeRefs: (Array.isArray(source.animeRefs) ? source.animeRefs : []).filter(item => item && Number.isSafeInteger(Number(item.anilistId)) && Number(item.anilistId) > 0).slice(-12),
    resultRefs: (Array.isArray(source.resultRefs) ? source.resultRefs : []).filter(item => item?.tool === 'final_answer').slice(-3),
    openQuestions: (Array.isArray(source.openQuestions) ? source.openQuestions : []).map(String).slice(-4),
    completedOperations: (Array.isArray(source.completedOperations) ? source.completedOperations : []).slice(-4) };
}

function rememberResult(state, name, result) {
  if (name === 'resolve_anime') state.openQuestions = result?.status === 'ambiguous' ? ['作品身份尚未消歧，请让用户确认具体作品或季别。'] : [];
  const cards = (result?.cards || (result?.card ? [result.card] : [])).filter(item => Number(item.anilistId) > 0);
  if (!cards.length) return;
  const refs = cards.slice(0, 12).map(item => ({ anilistId: Number(item.anilistId), title: String(item.title || '').replace(/\s+/g, ' ').slice(0, 120) }));
  state.animeRefs = [...new Map([...state.animeRefs, ...refs].map(item => [item.anilistId, item])).values()].slice(-12);
  // Only displayed lists persist ordinals; current-turn evidence stays in DisplayResults.
  if (name === 'final_answer') {
    const ref = { resultId: randomUUID(), tool: name, sourceTool: result.sourceTool || name,
      ...(result.artifactId ? { artifactId: result.artifactId } : {}), items: refs, createdAt: Date.now() };
    state.resultRefs = [...state.resultRefs.filter(item => item.resultId !== ref.resultId), ref].slice(-3);
    return ref;
  }
}

function currentConstraints(state, turnId) {
  const now = Date.now();
  return state.constraints.filter(item => (!item.expiresAt || item.expiresAt > now) && (item.scope !== 'turn' || item.turnId === turnId));
}

module.exports = { sessionState, rememberResult, currentConstraints };
