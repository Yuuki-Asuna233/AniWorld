const { fetchJson, throwIfAborted } = require('../shared/runtime');
const { enrichSearchResults } = require('./source-quality');
const { envInt, cleanText } = require('../shared/utils');

const DEFAULT_ALLOWED_DOMAINS = [
  'animenewsnetwork.com',
  'crunchyroll.com',
  'anilist.co',
  'myanimelist.net',
  'kadokawa.co.jp',
  'shinkaiworks.com',
  'toho.co.jp',
  'aniplex.co.jp',
  'ghibli.jp',
  're-zero-anime.jp',
  'officiallytranslated.com'
];

const cache = new Map();

function splitCsv(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getConfig() {
  const provider = String(process.env.WEB_SEARCH_PROVIDER || '').trim().toLowerCase();
  const tavilyKey = String(process.env.TAVILY_API_KEY || '').trim();
  const maxResults = envInt('WEB_SEARCH_MAX_RESULTS', 5, 1, 10);
  const timeoutMs = envInt('WEB_SEARCH_TIMEOUT_MS', 8000, 2000, 20000);
  const allowedDomains = splitCsv(process.env.WEB_SEARCH_ALLOWED_DOMAINS);
  const strictDomains = ['1', 'true', 'yes'].includes(String(process.env.WEB_SEARCH_STRICT_DOMAINS || '').toLowerCase());
  return {
    provider: provider || (tavilyKey ? 'tavily' : ''),
    tavilyKey,
    maxResults,
    timeoutMs,
    allowedDomains: allowedDomains.length ? allowedDomains : DEFAULT_ALLOWED_DOMAINS,
    strictDomains
  };
}

function normalizeTavilyResult(item) {
  return {
    title: cleanText(item.title, 160),
    url: String(item.url || '').trim(),
    content: cleanText(item.content || item.raw_content || '', 700),
    score: Number(item.score) || 0,
    publishedDate: item.published_date || item.publishedDate || ''
  };
}

function cacheKey(provider, query, maxResults) {
  return `${provider}:${maxResults}:${String(query || '').trim().toLowerCase()}`;
}

async function tavilySearch(query, config, options = {}) {
  const body = {
    query,
    topic: 'general',
    search_depth: 'basic',
    max_results: config.maxResults,
    include_answer: false,
    include_raw_content: false,
    include_images: false
  };
  if (options.useDomains !== false && config.allowedDomains?.length) body.include_domains = config.allowedDomains;
  const response = await fetchJson('https://api.tavily.com/search', {
    method: 'POST',
    signal: options.signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${config.tavilyKey}`
    },
    body: JSON.stringify(body)
  }, { timeoutMs: config.timeoutMs });
  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  return results.map(normalizeTavilyResult).filter(item => item.title && item.url);
}

async function searchAnimeEvidence(input = {}) {
  throwIfAborted(input.signal);
  const query = cleanText(input.query, 240);
  const config = getConfig();
  const purpose = input.purpose || 'stable';
  if (!query) return { configured: Boolean(config.provider), purpose, attempted: false, results: [], error: 'EMPTY_QUERY' };
  if (config.provider !== 'tavily') {
    return {
      configured: false,
      purpose,
      attempted: false,
      provider: config.provider || '',
      results: [],
      message: 'WEB_SEARCH_DISABLED', error: 'WEB_SEARCH_DISABLED', errorCode: 'CAPABILITY_UNAVAILABLE'
    };
  }
  if (!config.tavilyKey) {
    return {
      configured: false,
      purpose,
      attempted: false,
      provider: 'tavily',
      results: [],
      message: 'MISSING_TAVILY_API_KEY', error: 'WEB_SEARCH_NOT_CONFIGURED', errorCode: 'CAPABILITY_UNAVAILABLE'
    };
  }

  const maxResults = Math.max(1, Math.min(Number(input.maxResults) || config.maxResults, 10));
  const finalConfig = { ...config, maxResults };
  const key = purpose + ':' + cacheKey(finalConfig.provider, query, maxResults);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < (purpose === 'latest' ? 60 * 1000 : 10 * 60 * 1000)) {
    return { ...cached.value, cached: true };
  }

  // Search the whole web and let enrichSearchResults rank by source trust.
  // Forcing include_domains only removed recall: when a work's real sources sit
  // outside the allow list (Wikipedia, the publisher, the show's own site),
  // Tavily still answered with unrelated pages from the allowed hosts, and that
  // non-empty junk meant the "retry without domains" branch below never fired.
  // WEB_SEARCH_STRICT_DOMAINS=1 restores the old restricted behaviour.
  const restrictToAllowedDomains = finalConfig.strictDomains === true;
  const results = enrichSearchResults(await tavilySearch(query, finalConfig, {
    useDomains: restrictToAllowedDomains,
    signal: input.signal
  }));
  const value = {
    configured: true,
    attempted: true,
    provider: 'tavily',
    purpose,
    searchedAt: new Date().toISOString(),
    query,
    results,
    message: results.length ? 'OK' : 'NO_RESULTS'
  };
  if (cache.size >= 500) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { searchAnimeEvidence, getWebSearchConfig: getConfig };
