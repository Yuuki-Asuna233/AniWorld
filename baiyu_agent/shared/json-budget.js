const { estimateTokens, truncateToTokens } = require('../memory/memory');

// Reduce data fields, never cut encoded JSON or discard an operation's status.
function encodeWithinBudget(value, budget) {
  const copy = JSON.parse(JSON.stringify(value ?? {}));
  const encode = () => JSON.stringify(copy);
  for (let guard = 0; estimateTokens(encode()) > budget && guard < 200; guard++) {
    const candidates = [];
    const visit = (item, depth = 0, prefix = '') => {
      if (!item || typeof item !== 'object') return;
      for (const [key, field] of Object.entries(item)) {
        if (['error', 'outcome', 'status', 'pendingAction', 'operationId', 'intent', 'actions', 'answer', 'displayItems', 'truncation',
          'id', 'memoryId', 'artifactId', 'resultId', 'key', 'nextOffset', 'offset'].includes(key)) continue;
        const path = prefix ? `${prefix}.${key}` : key;
        const mark = () => { (copy.truncation || (copy.truncation = { truncated: true, fields: {} })).fields[path] = true; };
        if (Array.isArray(field) && field.length > 1) candidates.push({ size: estimateTokens(JSON.stringify(field)), reduce: () => { field.pop(); mark(); } });
        else if (Array.isArray(field) && field.length === 1 && depth < 8) visit(field, depth + 1, path);
        else if (typeof field === 'string' && field.length > 100) candidates.push({ size: estimateTokens(field), reduce: () => { item[key] = truncateToTokens(field, Math.max(30, Math.floor(estimateTokens(field) / 2))); mark(); } });
        else if (depth < 8) visit(field, depth + 1, path);
      }
    };
    visit(copy);
    candidates.sort((a, b) => b.size - a.size);
    if (!candidates.length) break;
    candidates[0].reduce();
  }
  return encode();
}

module.exports = { encodeWithinBudget };
