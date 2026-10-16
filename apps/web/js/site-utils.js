(function exposeSiteUtils(global) {
  'use strict';

  const AUTH_TOKEN_KEY = 'anime_token';
  let authRevision = 0;
  global.addEventListener('storage', event => {
    if (event.key === AUTH_TOKEN_KEY || event.key === null) authRevision++;
  });

  function escapeHtml(value) {
    if (value === null || value === undefined || value === '') return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeImageUrl(value) {
    if (!value) return '';
    if (/^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)) return value;
    try {
      const url = new URL(String(value || ''), location.origin);
      return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
    } catch (_) { return ''; }
  }

  function coverUrls(item = {}) {
    return [...new Set([
      item.image || item.anime_image || item.cover || item.images?.large,
      item.coverFallback || item.images?.fallback
    ].map(safeImageUrl).filter(Boolean))];
  }

  function onCoverError(image) {
    const fallback = image.dataset.coverFallback;
    delete image.dataset.coverFallback;
    if (fallback && fallback !== image.getAttribute('src')) image.src = fallback;
    else image.style.visibility = 'hidden';
  }

  function coverImageAttributes(item) {
    const urls = coverUrls(item);
    return (urls[0] ? `src="${escapeHtml(urls[0])}" ` : 'style="visibility:hidden" ') +
      `data-cover-fallback="${escapeHtml(urls[1] || '')}" onerror="window.SiteUtils.onCoverError(this)"`;
  }

  function setCoverImage(image, item) {
    const urls = coverUrls(item);
    image.onerror = () => onCoverError(image);
    image.dataset.coverFallback = urls[1] || '';
    image.style.visibility = urls.length ? '' : 'hidden';
    if (urls[0]) image.src = urls[0];
    else image.removeAttribute('src');
  }

  function toast(message, color = '#e85d04') {
    const element = document.createElement('div');
    element.className = 'toast';
    element.textContent = String(message || '');
    element.style.background = color;
    document.body.appendChild(element);
    setTimeout(() => element.remove(), 2500);
  }

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY);
  }

  function setAuthToken(token) {
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    authRevision++;
  }

  function clearAuthToken() {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    authRevision++;
  }

  function captureAuthSession() {
    const token = getAuthToken(), revision = authRevision;
    return Object.freeze({
      token,
      headers: Object.freeze(token ? { Authorization: `Bearer ${token}` } : {}),
      isCurrent: () => revision === authRevision && token === getAuthToken()
    });
  }

  function authHeaders(accept = 'application/json') {
    const headers = { 'Content-Type': 'application/json', Accept: accept };
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  class HttpResponseError extends Error {
    constructor(status, data) {
      super(data?.error || data?.message || `服务器返回 HTTP ${status}`);
      this.name = 'HttpResponseError';
      this.status = status;
      this.data = data;
    }
  }

  async function authJson(method, url, body = null, options = {}) {
    if (options.session && !options.session.isCurrent()) throw new DOMException('账户已切换', 'AbortError');
    const normalizedMethod = String(method || 'GET').toUpperCase();
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json',
      ...(options.session ? options.session.headers : authHeaders()), ...(options.headers || {}) };

    let requestUrl = String(url || '');
    if (options.cacheBust && normalizedMethod === 'GET') {
      const separator = requestUrl.includes('?') ? '&' : '?';
      requestUrl += `${separator}_t=${Date.now()}`;
    }

    const requestOptions = {
      method: normalizedMethod,
      headers,
      cache: options.cache || 'no-store',
      ...(options.signal ? { signal: options.signal } : {})
    };
    if (body !== null && body !== undefined) requestOptions.body = JSON.stringify(body);

    const response = await fetch(requestUrl, requestOptions);
    let data;
    try { data = await response.json(); }
    catch (error) {
      if (options.requireSuccess) throw new HttpResponseError(response.status, null);
      throw error;
    }
    if (options.requireSuccess && !response.ok) throw new HttpResponseError(response.status, data);
    return data;
  }

  global.SiteUtils = Object.freeze({
    authHeaders,
    authJson,
    captureAuthSession,
    clearAuthToken,
    escapeHtml,
    safeImageUrl,
    coverImageAttributes,
    onCoverError,
    setCoverImage,
    getAuthToken,
    setAuthToken,
    toast
  });
})(window);
