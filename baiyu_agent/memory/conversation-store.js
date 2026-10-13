const { randomUUID } = require('crypto');
const { memoryConfig, estimateTokens, trimHistoryForContext } = require('./memory');
const { memorySearchTerms, scoreMemory } = require('./user-memory');
const { sessionState } = require('./session-state');
const { compactConversation } = require('./compaction');
const { contextBudget } = require('../agents/budget');
const { buildMessages, contextTokenCount } = require('../agents/context');
const { MemoryManager } = require('./manager');
const { createAgentTelemetry } = require('../../apps/server/src/services/agent-telemetry');

class AgentConversationStore {
  constructor(database, { maxGuestSessions = 500 } = {}) {
    this.database = database;
    this.maxGuestSessions = maxGuestSessions;
    this.guestSessions = new Map();
    this.workerRunning = false;
    this.maintenanceTimer = null;
    this.maintenanceStopped = false;
    this.maintenanceAbort = null;
    this.maintenanceWork = null;
  }
  guest(sessionId) {
    const state = this.guestSessions.get(sessionId);
    if (!state || state.expiresAt < Date.now()) throw new Error('GUEST_SESSION_EXPIRED');
    state.expiresAt = Date.now() + 30 * 60000;
    return state;
  }
  snapshot(userId, sessionId) {
    if (userId) return this.database.getAgentContextSnapshot(sessionId, userId);
    const guest = this.guest(sessionId);
    return { state: sessionState(guest.state), revision: guest.revision, memory: { revision: guest.epoch || 0, epoch: guest.epoch || 0, historyFloorId: guest.historyFloorId || 0, items: [] },
      summary: guest.summary || '', summaryId: guest.summaryId || '', throughId: Math.max(guest.throughId || 0, guest.historyFloorId || 0),
      cursor: guest.cursor || {}, pendingAction: guest.pendingAction || '' };
  }
  compactionSources(userId, sessionId, afterId) {
    if (!userId) return this.guest(sessionId).history.filter(item => item.id > afterId);
    const epoch = this.database.getAgentMemorySnapshot(userId).epoch, refs = new Map();
    return this.database.getAgentCompactionMessages(sessionId, afterId, 512).map(row => {
      if (!refs.has(row.request_id)) refs.set(row.request_id, this.database.getAgentEventReferences(userId, sessionId, row.request_id, epoch));
      return { ...row, evidenceRefs: refs.get(row.request_id) };
    });
  }
  checkpoint(input) {
    if (input.userId) return this.database.commitAgentSummaryCheckpoint(input);
    const guest = this.guest(input.sessionId);
    if (guest.revision !== input.revision || (guest.epoch || 0) !== input.epoch || (guest.summaryId || '') !== input.parentId) return { conflict: true };
    Object.assign(guest, { summary: input.summary, summaryId: JSON.parse(input.summary).id, throughId: input.throughId, cursor: input.cursor, revision: guest.revision + 1 });
    return { success: true };
  }
  saveState(userId, sessionId, state, revision, epoch, options = {}) {
    if (userId) return this.database.commitAgentState({ userId, sessionId, state, revision, epoch, ...options });
    const guest = this.guest(sessionId);
    if (guest.revision !== revision || (guest.epoch || 0) !== epoch) throw new Error('CONTEXT_REVISION_CONFLICT');
    if (options.quarantine) Object.assign(guest, { epoch: epoch + 1, historyFloorId: guest.history.at(-1)?.id || 0,
      summary: '', summaryId: '', throughId: guest.history.at(-1)?.id || 0, cursor: {} });
    guest.state = sessionState(state);
    guest.revision++;
    return { success: true };
  }
  event(options) {
    try { if (options.userId) this.database.appendAgentContextEvent(options); }
    catch (error) { require('../diagnostics/diagnostics').recordAgentEvent('context_event_error', { error: error.message }); }
  }
  artifact(options) {
    if (!options.userId) return { omitted: 'guest' };
    try { return this.database.saveAgentContextArtifact(options); }
    catch (error) { require('../diagnostics/diagnostics').recordAgentEvent('artifact_error', { error: error.message }); return { omitted: 'storage_error' }; }
  }
  prepare({ userId, sessionId, message }) {
    let id = String(sessionId || '').trim();
    if (userId) {
      if (!id || !this.database.getAgentSession(id, userId)) {
        id = randomUUID();
        this.database.createAgentSession(id, userId, String(message).slice(0, 40));
      }
    } else {
      for (const [key, guest] of this.guestSessions) if (guest.expiresAt < Date.now()) this.guestSessions.delete(key);
      if (!id || !this.guestSessions.has(id)) {
        id = randomUUID();
        this.guestSessions.set(id, { history: [], state: {}, revision: 0, expiresAt: Date.now() + 30 * 60000 });
        while (this.guestSessions.size > this.maxGuestSessions) this.guestSessions.delete(this.guestSessions.keys().next().value);
      }
    }
    const snapshot = this.snapshot(userId, id), config = memoryConfig();
    let history = [], beforeId = 0, used = 0;
    if (userId) {
      // Iterate owner-scoped pages until the token budget, rather than loading a fixed 32-message window.
      while (history.length < config.historyMessages && used < config.historyTokenBudget) {
        const batch = this.database.getAgentHistoryPage(userId, id, snapshot.throughId, beforeId, Math.min(128, config.historyMessages - history.length));
        if (!batch.length) break;
        history = [...batch, ...history];
        used += estimateTokens(batch.map(item => item.content).join('\n'));
        beforeId = batch[0].id;
      }
    } else history = this.guest(id).history.filter(item => item.id > snapshot.throughId);
    history = trimHistoryForContext(history, config.historyTokenBudget);
    const candidates = this.compactionSources(userId, id, snapshot.throughId);
    const first = history[0]?.id || Infinity;
    return { sessionId: id, contextSnapshot: snapshot, history,
      sessionSummary: snapshot.summary, userMemorySummary: '', pendingAction: snapshot.pendingAction,
      summaryThroughId: snapshot.throughId, compactionCandidates: candidates, relatedMemories: [],
      historyHasOlder: candidates.some(item => item.id < first), historyIncomplete: Boolean((!snapshot.summary && candidates.some(item => item.id < first)) || (!userId && this.guest(id).historyIncomplete)) };
  }
  searchGuestHistory(sessionId, query, limit = 3) {
    const terms = memorySearchTerms(query);
    const guest = this.guest(sessionId);
    return guest.history.filter(item => item.id > (guest.historyFloorId || 0)).map(item => ({ ...item, score: scoreMemory(item.content, terms) }))
      .filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(limit, 4))
      .map(item => ({ eventId: item.id, role: item.role, content: item.content.slice(0, 2400) }));
  }
  commit({ userId, sessionId, message, result, pendingAction, requestId, inputHash }) {
    const snapshot = this.snapshot(userId, sessionId);
    if (userId) {
      const committed = this.database.commitAgentTurn(sessionId, userId, message, result.answer, result.cards || [], '', pendingAction, '',
        { requestId, inputHash, result, suppressHistory: result.suppressHistory, contextRevision: snapshot.revision, sessionState: result.sessionState || snapshot.state });
      if (!committed || committed.error) throw new Error(committed?.error || 'AGENT_TURN_NOT_COMMITTED');
    } else {
      const guest = this.guest(sessionId);
      const lastId = guest.history.at(-1)?.id || guest.throughId || 0;
      guest.history.push({ id: lastId + 1, role: 'user', content: message },
        { id: lastId + 2, role: 'assistant', content: result.answer });
      if (result.suppressHistory) guest.historyFloorId = lastId + 2;
      guest.state = sessionState(result.sessionState || snapshot.state);
      guest.pendingAction = pendingAction;
      guest.revision++;
      const retained = trimHistoryForContext(guest.history.filter(item => item.id > guest.throughId), memoryConfig().historyTokenBudget * 2);
      guest.historyIncomplete = retained.length < guest.history.filter(item => item.id > guest.throughId).length;
      guest.history = retained;
    }
  }
  maintain({ userId, sessionId, provider, targetId }) {
    if (!provider?.isConfigured?.()) return;
    if (!userId) return; // Guest compaction stays in the bounded foreground request.
    const epoch = this.snapshot(userId, sessionId).memory.epoch;
    this.database.enqueueAgentMaintenance(sessionId, userId, epoch, targetId);
    this.startMaintenance(provider);
  }
  startMaintenance(provider) {
    if (this.maintenanceStopped || this.workerRunning || !provider?.isConfigured?.() || process.env.AGENT_BACKGROUND_COMPACTION === 'false') return;
    clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.workerRunning = true;
    const controller = new AbortController();
    this.maintenanceAbort = controller;
    const drain = async () => {
      let job, telemetry;
      try {
        if (controller.signal.aborted) return;
        job = this.database.claimAgentMaintenance();
        if (!job) return;
        const snapshot = this.snapshot(job.user_id, job.session_id);
        if (snapshot.memory.epoch !== job.epoch) { this.database.finishAgentMaintenance(job, true); return; }
        const loaded = this.prepare({ userId: job.user_id, sessionId: job.session_id, message: '' });
        const budget = contextBudget(provider);
        const manager = new MemoryManager({ conversationStore: this, database: this.database,
          userId: job.user_id, sessionId: job.session_id, contextSnapshot: snapshot, message: '', requestId: '' });
        const tools = require('../index').toolRegistry.available({ userId: job.user_id });
        const fixed = contextTokenCount(buildMessages({ userId: job.user_id, history: [], message: '',
          sessionState: manager.state, sessionSummary: snapshot.summary, pendingAction: snapshot.pendingAction,
          userMemorySummary: manager.view() }), tools);
        const retained = trimHistoryForContext(loaded.history, Math.max(1000, budget.low - fixed));
        const firstRetained = retained[0]?.id || Infinity;
        const sources = this.compactionSources(job.user_id, job.session_id, snapshot.throughId);
        let targetId = Math.max(snapshot.throughId, Number(job.target_id) || 0, ...sources
          .filter(item => item.role === 'assistant' && item.id < firstRetained).map(item => item.id));
        if (sources.find(item => item.id === targetId)?.role === 'user') {
          targetId = Math.max(snapshot.throughId, ...sources.filter(item => item.role === 'assistant' && item.id < targetId).map(item => item.id));
        }
        if (targetId <= snapshot.throughId) { this.database.finishAgentMaintenance(job, true); return; }
        telemetry = createAgentTelemetry({ database: this.database, runId: randomUUID(), userId: job.user_id,
          sessionId: job.session_id, model: provider.model, message: '', pageContext: { page: 'agent_maintenance' } });
        const result = await compactConversation({ provider, conversationStore: this, userId: job.user_id, sessionId: job.session_id, targetId, signal: controller.signal,
          onModelRequest: event => telemetry.modelRequest({ ...event, round: 0 }) });
        telemetry.finish({ status: result.progressed ? 'success' : result.conflict ? 'cancelled' : 'error', errorCode: result.error || '' });
        const fresh = this.snapshot(job.user_id, job.session_id);
        const complete = fresh.throughId >= targetId;
        const applied = this.database.finishAgentMaintenance(job, complete);
        if (applied && result.progressed && !complete) this.database.enqueueAgentMaintenance(job.session_id, job.user_id, job.epoch, targetId);
      } catch (error) {
        telemetry?.finish({ status: controller.signal.aborted ? 'cancelled' : 'error', errorCode: error.message });
        // A shutdown leaves running jobs for the existing startup recovery;
        // it must not consume a retry attempt or access a closed database.
        if (!controller.signal.aborted) {
          if (job) this.database.finishAgentMaintenance(job, false);
          require('../diagnostics/diagnostics').recordAgentEvent('maintenance_error', { error: error.message });
        }
      } finally {
        this.workerRunning = false;
        this.maintenanceAbort = null;
        if (!this.maintenanceStopped) {
          const nextAt = this.database.nextAgentMaintenanceAt();
          if (nextAt !== null) {
            this.maintenanceTimer = setTimeout(() => this.startMaintenance(provider), Math.max(50, nextAt - Date.now()));
            this.maintenanceTimer.unref();
          }
        }
      }
    };
    this.maintenanceWork = new Promise(resolve => setImmediate(resolve)).then(drain).catch(error => {
      require('../diagnostics/diagnostics').recordAgentEvent('maintenance_error', { error: error.message });
    });
  }
  stopMaintenance() {
    this.maintenanceStopped = true;
    clearTimeout(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.maintenanceAbort?.abort(new Error('AGENT_MAINTENANCE_STOPPED'));
    return this.maintenanceWork || Promise.resolve();
  }
}

module.exports = { AgentConversationStore };
