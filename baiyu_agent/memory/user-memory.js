const { createHash } = require('crypto');
const { cleanText } = require('../shared/utils');
const { estimateTokens, memoryConfig } = require('./memory');

const STORE_VERSION = 1;
function emptyUserMemory() {
  return {
    version: STORE_VERSION,
    preferences: { positive: [], negative: [], constraints: [] },
    facts: [],
    titles: []
  };
}

function uniqueStrings(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(value, 360);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result.slice(-limit);
}

function normalizeFact(fact) {
  if (typeof fact === 'string') fact = { kind: 'fact', value: fact, confidence: 0.6, source: 'legacy' };
  if (!fact || typeof fact !== 'object') return null;
  const value = cleanText(fact.value || fact.fact || fact.text, 320);
  if (!value) return null;
  return {
    id: String(fact.id || createHash('sha256').update(`${fact.kind || 'fact'}:${value}`).digest('hex').slice(0, 24)).slice(0, 64),
    kind: cleanText(fact.kind || 'fact', 40),
    value,
    confidence: Math.max(0, Math.min(Number.isFinite(Number(fact.confidence)) ? Number(fact.confidence) : 0.6, 1)),
    source: cleanText(fact.source || 'conversation', 40),
    createdAt: String(fact.createdAt || '').slice(0, 40),
    updatedAt: String(fact.updatedAt || '').slice(0, 40),
    expiresAt: String(fact.expiresAt || '').slice(0, 40)
  };
}

function parseLegacyMemory(raw) {
  const memory = emptyUserMemory();
  for (const rawLine of String(raw || '').split('\n')) {
    const line = cleanText(rawLine, 360);
    if (/^用户喜欢\/想看：/.test(line)) memory.preferences.positive.push(line.replace(/^[^：]+：/, ''));
    else if (/^用户不喜欢\/排除：/.test(line)) memory.preferences.negative.push(line.replace(/^[^：]+：/, ''));
    else if (/^推荐约束：/.test(line)) memory.preferences.constraints.push(line.replace(/^[^：]+：/, ''));
    else if (/^对话涉及作品：/.test(line)) memory.titles.push(...line.replace(/^[^：]+：/, '').split('、'));
  }
  return normalizeUserMemory(memory);
}

function parseUserMemory(value) {
  const raw = String(value || '').trim();
  if (!raw) return emptyUserMemory();
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.preferences) return normalizeUserMemory(parsed);
  } catch (_) {}
  return parseLegacyMemory(raw);
}

function normalizeUserMemory(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    version: STORE_VERSION,
    preferences: {
      // The authoritative store allows 1,000 items plus 64 scoped requirements in a working view.
      positive: uniqueStrings(source.preferences?.positive, 1064),
      negative: uniqueStrings(source.preferences?.negative, 1064),
      constraints: uniqueStrings(source.preferences?.constraints, 1064)
    },
    facts: [...new Map((Array.isArray(source.facts) ? source.facts : []).map(normalizeFact)
      .filter(fact => fact && (!fact.expiresAt || (Number.isFinite(Date.parse(fact.expiresAt)) && Date.parse(fact.expiresAt) > Date.now())))
      .map(fact => [fact.id, fact])).values()].slice(-1000),
    titles: uniqueStrings(source.titles, 1000)
  };
}

function compactUserMemory(input, tokenBudget = memoryConfig().userStoreTokenBudget) {
  const config = memoryConfig();
  const memory = normalizeUserMemory(input);
  const encoded = () => JSON.stringify(memory);
  const tooLarge = () => estimateTokens(encoded()) > tokenBudget || encoded().length > config.summaryCharLimit;
  while (tooLarge() && memory.titles.length) memory.titles.shift();
  while (tooLarge() && memory.facts.length) memory.facts.shift();
  for (const kind of ['positive', 'negative', 'constraints']) {
    while (tooLarge() && memory.preferences[kind].length) memory.preferences[kind].shift();
  }
  return encoded();
}

function renderUserMemory(value) {
  const memory = normalizeUserMemory(typeof value === 'string' ? parseUserMemory(value) : value);
  const lines = [];
  if (memory.preferences.positive.length) lines.push(`明确喜欢：${memory.preferences.positive.join('；')}`);
  if (memory.preferences.negative.length) lines.push(`明确不喜欢：${memory.preferences.negative.join('；')}`);
  if (memory.preferences.constraints.length) lines.push(`推荐约束：${memory.preferences.constraints.join('；')}`);
  if (memory.facts.length) lines.push(`已确认事实：${memory.facts.slice(-8).map(item => item.value).join('；')}`);
  if (memory.titles.length) lines.push(`长期提到的作品：${memory.titles.join('、')}`);
  return lines.join('\n');
}

function memorySearchTerms(text) {
  const value = String(text || '').toLowerCase();
  const terms = new Set(value.match(/[a-z0-9]{2,}|[㐀-鿿]{2,}/g) || []);
  const cjk = [...value].filter(char => /[㐀-鿿]/u.test(char));
  for (let i = 0; i < cjk.length - 1; i += 1) terms.add(cjk[i] + cjk[i + 1]);
  return [...terms].filter(term => term.length >= 2).slice(0, 40);
}

function scoreMemory(text, queryTerms) {
  const value = String(text || '').toLowerCase();
  return queryTerms.reduce((score, term) => score + (value.includes(term) ? 1 : 0), 0);
}

module.exports = {
  emptyUserMemory,
  parseUserMemory,
  normalizeUserMemory,
  compactUserMemory,
  renderUserMemory,
  memorySearchTerms,
  scoreMemory
};
