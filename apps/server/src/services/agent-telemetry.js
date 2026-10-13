const { auditArguments } = require('../../../../baiyu_agent/shared/audit');
const { modelUsage } = require('./agent-model-usage');
const SENSITIVE_KEY = /key|token|authorization|password|secret|cookie|credential|sourceQuote/i;

function redact(value, depth = 0) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.length > 600 ? `${value.slice(0, 600)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth > 3) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 20).map(item => redact(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (SENSITIVE_KEY.test(key)) continue;
    result[key] = redact(item, depth + 1);
  }
  return result;
}

function json(value, fallback = '{}') {
  try { return JSON.stringify(redact(value)).slice(0, 4000); } catch (_) { return fallback; }
}

function hostnameOf(url) {
  try { return new URL(String(url || '')).hostname.replace(/^www\./i, ''); } catch (_) { return ''; }
}

// Status strings are short ("OK", "NO_RESULTS", "MISSING_TAVILY_API_KEY"), but a
// few tools put generated prose here, so keep only a bounded prefix.
function boundedMessage(value) {
  if (value === undefined || value === null) return undefined;
  return String(value).slice(0, 120);
}

function summarizeResult(result) {
  if (!result || typeof result !== 'object') return '';
  const summary = {};
  for (const key of ['found', 'partial', 'outcome', 'lowConfidence', 'personalized', 'requiresLogin', 'policyRejected', 'error', 'coverage', 'purpose', 'mode', 'attempted']) {
    if (result[key] !== undefined) summary[key] = result[key];
  }
  for (const key of ['cards', 'items', 'sources', 'actions']) {
    if (Array.isArray(result[key])) summary[`${key}Count`] = result[key].length;
  }
  // Search-style payloads (web search, external lookups) carry their hits under
  // `results`, which matches none of the keys above — so every
  // web search call was audited as "{}" and "did the search actually
  // return anything useful?" could not be answered from the database.
  const message = boundedMessage(result.message);
  if (message !== undefined) summary.message = message;
  if (Array.isArray(result.results)) {
    summary.resultCount = result.results.length;
    const hosts = [];
    for (const item of result.results) {
      const host = String(item?.host || '').trim() || hostnameOf(item?.url);
      if (host && !hosts.includes(host)) hosts.push(host);
      if (hosts.length >= 8) break;
    }
    if (hosts.length) summary.hosts = hosts;
  }
  if (result.retrieval && typeof result.retrieval === 'object') {
    summary.retrieval = {
      source: result.retrieval.source || '',
      mode: result.retrieval.mode || '',
      degraded: Boolean(result.retrieval.degraded),
      externalUsed: Boolean(result.retrieval.externalUsed),
      externalAttempted: Boolean(result.retrieval.externalAttempted),
      externalError: boundedMessage(result.retrieval.externalError) || '',
      scanned: Number(result.retrieval.scanned) || 0,
      resultCount: Array.isArray(result.retrieval.results) ? result.retrieval.results.length
        : Array.isArray(result.retrieval.chunks) ? result.retrieval.chunks.length : undefined,
      lowConfidence: Boolean(result.retrieval.lowConfidence)
    };
  }
  return json(summary, '');
}

function createAgentTelemetry({ database, runId, userId, sessionId, model, message, pageContext = {} }) {
  const startedAt = Date.now();
  let sequence = 0;
  const pending = new Map();
  const pendingModels = new Map();
  database.startAgentRun?.({
    runId,
    userId,
    sessionId,
    model,
    inputChars: String(message || '').length,
    page: String(pageContext.page || '').slice(0, 160)
  });

  return {
    runId,
    modelRequest(event = {}) {
      const round = Number(event.round) || 0;
      database.recordAgentModelRound?.(runId, round);
      if (event.phase === 'start') {
        pendingModels.set(round, { startedAt: Date.now(), event });
        return;
      }
      const pending = pendingModels.get(round);
      if (pending) pendingModels.delete(round);
      const usage = modelUsage(event.usage || {}, {
        inputTokens: Number(event.estimatedInputTokens || pending?.event?.estimatedInputTokens)
          || Math.ceil((Number(event.inputChars) || pending?.event?.inputChars || 0) / 4),
        outputTokens: Number(event.estimatedOutputTokens) || Math.ceil((Number(event.outputChars) || 0) / 4)
      });
      database.recordAgentModelCall?.(runId, {
        sequence: round + 1,
        model: event.model || pending?.event?.model || model,
        status: event.phase === 'error' ? 'error' : 'success',
        durationMs: Number(event.durationMs) || (pending ? Date.now() - pending.startedAt : 0),
        ...usage,
        purpose: event.purpose || pending?.event?.purpose || event.stage || pending?.event?.stage || 'unknown',
        firstTokenMs: event.firstTokenMs ?? null,
        firstTextMs: event.firstTextMs ?? null,
        inputChars: Number(event.inputChars) || pending?.event?.inputChars || 0,
        outputChars: Number(event.outputChars) || 0,
        toolsAvailable: Number(event.tools) || pending?.event?.tools || 0,
        errorCode: event.errorCode || ''
      });
    },
    toolStart({ name, args, sequence: sequenceHint }) {
      const callSequence = Math.max(1, Number(sequenceHint) || sequence + 1);
      sequence = Math.max(sequence, callSequence);
      const item = { sequence: callSequence, startedAt: Date.now(), args };
      pending.set(item.sequence, item);
      return item.sequence;
    },
    toolResult({ name, args, result, sequence: sequenceHint }) {
      const item = pending.get(sequenceHint) || [...pending.values()].find(value => value.args === args);
      if (item) pending.delete(item.sequence);
      database.recordAgentToolCall?.(runId, {
        sequence: item?.sequence || sequenceHint || sequence,
        name,
        status: result?.outcome || (result?.policyRejected ? 'rejected' : result?.error ? 'error' : 'success'),
        durationMs: item ? Date.now() - item.startedAt : 0,
        argsJson: json(auditArguments(args)),
        resultSummary: summarizeResult(result),
        errorCode: result?.error || '',
        policyRejected: Boolean(result?.policyRejected)
      });
    },
    toolError({ name, args, error, sequence: sequenceHint }) {
      const item = pending.get(sequenceHint) || [...pending.values()].find(value => value.args === args);
      if (item) pending.delete(item.sequence);
      database.recordAgentToolCall?.(runId, {
        sequence: item?.sequence || sequenceHint || sequence,
        name,
        status: 'error',
        durationMs: item ? Date.now() - item.startedAt : 0,
        argsJson: json(auditArguments(args)),
        errorCode: String(error || '').slice(0, 200),
        resultSummary: ''
      });
    },
    finish({ status = 'success', fallback = false, answer = '', cards = [], sources = [], errorCode = '' } = {}) {
      database.finishAgentRun?.(runId, {
        status,
        fallback,
        durationMs: Date.now() - startedAt,
        answerChars: String(answer || '').length,
        cardsCount: Array.isArray(cards) ? cards.length : 0,
        sourcesCount: Array.isArray(sources) ? sources.length : 0,
        errorCode
      });
    }
  };
}

function configuredAdminValues(name) {
  return String(process.env[name] || '')
    .split(/[\s,;]+/)
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function isAgentAdmin(req, database) {
  const ids = configuredAdminValues('AGENT_ADMIN_USER_IDS');
  const emails = configuredAdminValues('AGENT_ADMIN_EMAILS');
  const user = req.user && database.getUserById(req.user.id);
  if (!user) return false;
  if (ids.includes(String(user.id))) return true;
  if (emails.includes(String(user.email || '').toLowerCase())) return true;
  return false;
}

module.exports = {
  createAgentTelemetry,
  isAgentAdmin,
  redact,
  summarizeResult
};
