(function () {
  'use strict';

  const $ = selector => document.querySelector(selector);
  const state = { page: 1, perPage: 25, query: '', year: '', month: '', status: '', total: 0, selected: null };
  const fields = ['title_chinese', 'oi_msg', 'oi_index', 'episodes', 'status'];
  const labels = {
    title_chinese: '中文名称', oi_msg: 'OI 名称', oi_index: 'OI 索引',
    episodes: '集数', status: '状态'
  };
  const statusLabels = {
    NOT_YET_RELEASED: '未上映', RELEASING: '连载中', FINISHED: '已完结',
    CANCELLED: '已取消', HIATUS: '暂停'
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function showNotice(message, kind = 'error') {
    const node = $('#notice');
    node.textContent = message || '';
    node.className = `notice ${kind}`;
    node.hidden = !message;
  }

  async function request(method, url, body) {
    const response = await fetch(url, {
      method,
      headers: SiteUtils.authHeaders(),
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function renderRows(items) {
    const node = $('#animeRows');
    if (!items.length) {
      node.innerHTML = '<tr><td colspan="6" class="empty">没有找到番剧</td></tr>';
      return;
    }
    node.innerHTML = items.map(item => `<tr data-id="${escapeHtml(item.anilist_id)}" class="${state.selected?.anilist_id === item.anilist_id ? 'selected' : ''}">
      <td>${escapeHtml(item.anilist_id)}</td><td>${escapeHtml(item.title_chinese || '—')}</td>
      <td>${escapeHtml(item.oi_msg || '—')}</td><td>${escapeHtml(item.oi_index)}</td>
      <td>${escapeHtml(item.episodes)}</td><td>${escapeHtml(statusLabels[item.status] || item.status || '—')}</td>
    </tr>`).join('');
    node.querySelectorAll('[data-id]').forEach(row => row.addEventListener('click', () => selectAnime(row.dataset.id)));
  }

  function totalPages() {
    return Math.max(1, Math.ceil(state.total / state.perPage));
  }

  function updatePager(loading = false) {
    const pages = totalPages();
    const current = Math.min(Math.max(state.page, 1), pages);
    state.page = current;
    $('#pageInfo').textContent = `第 ${current} 页 / 共 ${pages} 页`;
    $('#jumpPage').value = current;
    $('#jumpPage').max = pages;
    $('#first').disabled = loading || state.total === 0 || current <= 1;
    $('#previous').disabled = loading || state.total === 0 || current <= 1;
    $('#next').disabled = loading || state.total === 0 || current >= pages;
    $('#last').disabled = loading || state.total === 0 || current >= pages;
    $('#jump').disabled = loading || state.total === 0;
  }

  async function loadList() {
    updatePager(true);
    try {
      const params = new URLSearchParams({ page: String(state.page), perPage: String(state.perPage) });
      if (state.query) params.set('query', state.query);
      if (state.year) params.set('year', state.year);
      if (state.month) params.set('month', state.month);
      if (state.status) params.set('status', state.status);
      const data = await request('GET', `/api/admin/anime?${params}`);
      state.total = Number(data.total) || 0;
      state.page = Number(data.page) || state.page;
      renderRows(data.results || []);
      $('#summary').textContent = `共 ${state.total} 条`;
      updatePager(false);
      showNotice('');
    } catch (error) {
      showNotice(error.message);
      $('#animeRows').innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(error.message)}</td></tr>`;
      updatePager(false);
    }
  }

  function jumpToPage(value) {
    const pages = totalPages();
    const target = Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(target) || target < 1 || target > pages) {
      showNotice(`页码范围为 1～${pages}`, 'info');
      $('#jumpPage').focus();
      return;
    }
    if (target === state.page) return;
    state.page = target;
    loadList();
  }

  function setEditor(anime) {
    state.selected = anime;
    $('#editorForm').hidden = false;
    $('#editorHint').textContent = `正在编辑 #${anime.anilist_id}`;
    $('#anilistId').value = anime.anilist_id || '';
    $('#titleRomaji').value = anime.title_romaji || '';
    $('#titleNative').value = anime.title_native || '';
    $('#titleChinese').value = anime.title_chinese || '';
    $('#oiMsg').value = anime.oi_msg || '';
    $('#oiIndex').value = anime.oi_index ?? 1;
    $('#episodes').value = anime.episodes ?? 0;
    $('#status').value = anime.status || 'NOT_YET_RELEASED';
    $('#reset').disabled = false;
    loadHistory(anime.anilist_id);
    loadList();
  }

  async function selectAnime(id) {
    try {
      const data = await request('GET', `/api/admin/anime/${encodeURIComponent(id)}`);
      setEditor(data.anime);
    } catch (error) {
      showNotice(error.message);
    }
  }

  function formValues() {
    return {
      title_chinese: $('#titleChinese').value.trim(),
      oi_msg: $('#oiMsg').value.trim(),
      oi_index: Number($('#oiIndex').value),
      episodes: Number($('#episodes').value),
      status: $('#status').value
    };
  }

  function changedFields(values) {
    return fields.filter(field => String(values[field] ?? '') !== String(state.selected[field] ?? ''));
  }

  function formatValue(field, value) {
    return field === 'status' ? (statusLabels[value] || value || '空') : (value === '' ? '空' : value);
  }

  async function save(event) {
    event.preventDefault();
    if (!state.selected) return;
    const values = formValues();
    const changed = changedFields(values);
    if (!changed.length) return showNotice('没有需要保存的修改', 'info');
    const summary = changed.map(field => `${labels[field]}：${formatValue(field, state.selected[field])} → ${formatValue(field, values[field])}`).join('\n');
    if (!window.confirm(`确认保存以下修改？\n\n${summary}`)) return;
    if ((!values.title_chinese || !values.oi_msg) && !window.confirm('中文名称或 OI 名称为空，可能影响搜索和番剧匹配，仍要保存吗？')) return;
    $('#save').disabled = true;
    try {
      const data = await request('PATCH', `/api/admin/anime/${state.selected.anilist_id}`, values);
      setEditor(data.anime);
      await loadList();
      showNotice('修改已保存并立即生效', 'success');
    } catch (error) {
      showNotice(error.message);
    } finally {
      $('#save').disabled = false;
    }
  }

  function renderHistory(items) {
    const node = $('#history');
    if (!items.length) { node.className = 'history empty'; node.textContent = '暂无修改记录'; return; }
    node.className = 'history';
    node.innerHTML = items.map(item => `<article class="history-item">
      <div class="history-meta">${escapeHtml(new Date(Number(item.created_at) * 1000).toLocaleString('zh-CN', { hour12: false }))} · ${escapeHtml(item.editor_name || `用户 #${item.user_id || '?'}`)}</div>
      ${Object.entries(item.changed_fields || {}).map(([field, change]) => `<div><strong>${escapeHtml(labels[field] || field)}</strong>：${escapeHtml(formatValue(field, change.old))} → ${escapeHtml(formatValue(field, change.new))}</div>`).join('')}
    </article>`).join('');
  }

  async function loadHistory(id) {
    $('#history').className = 'history empty';
    $('#history').textContent = '正在加载修改记录…';
    try {
      const data = await request('GET', `/api/admin/anime/${encodeURIComponent(id)}/edits`);
      renderHistory(data.edits || []);
    } catch (error) {
      $('#history').textContent = error.message;
    }
  }

  $('#searchForm').addEventListener('submit', event => {
    event.preventDefault();
    state.query = $('#query').value.trim();
    state.year = $('#year').value.trim();
    state.month = $('#month').value;
    state.status = $('#filterStatus').value;
    state.page = 1;
    loadList();
  });
  $('#refresh').addEventListener('click', loadList);
  $('#first').addEventListener('click', () => jumpToPage(1));
  $('#previous').addEventListener('click', () => { if (state.page > 1) { state.page--; loadList(); } });
  $('#next').addEventListener('click', () => { if (state.page < totalPages()) { state.page++; loadList(); } });
  $('#last').addEventListener('click', () => jumpToPage(totalPages()));
  $('#jump').addEventListener('click', () => jumpToPage($('#jumpPage').value));
  $('#jumpPage').addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault();
      jumpToPage(event.currentTarget.value);
    }
  });
  $('#editorForm').addEventListener('submit', save);
  $('#reset').addEventListener('click', () => state.selected && setEditor(state.selected));
  loadList();
}());
