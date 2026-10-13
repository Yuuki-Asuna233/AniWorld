const events = [];
const MAX_EVENTS = 80;

function clean(value) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(clean);
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|authorization|password|secret|sourceQuote/i.test(key)) continue;
      out[key] = clean(item);
    }
    return out;
  }
  return value;
}

function recordAgentEvent(type, payload = {}) {
  events.push({
    type,
    at: Math.floor(Date.now() / 1000),
    payload: clean(payload)
  });
  while (events.length > MAX_EVENTS) events.shift();
}

function getAgentDiagnostics() {
  return {
    now: Math.floor(Date.now() / 1000),
    events: events.slice().reverse()
  };
}

module.exports = { recordAgentEvent, getAgentDiagnostics };
