(function () {
  const $ = selector => document.querySelector(selector);
  const escapeHtml = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const number = value => (Number(value) || 0).toLocaleString('zh-CN');
  const compactNumber = value => {
    const n = Number(value) || 0;
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
  };
  const percent = (value, total) => total ? `${Math.round((Number(value) || 0) / total * 100)}%` : '—';
  const ms = value => Number(value) ? `${Math.round(Number(value))} ms` : '—';
  const date = value => value ? new Date(Number(value) * 1000).toLocaleString('zh-CN', { hour12: false }) : '—';
  const measuredMs = value => value == null ? '—' : `${Math.round(Number(value))} ms`;
  const cacheRatio = value => value == null ? '—' : `${(Number(value) * 100).toFixed(1)}%`;
  const cacheTokens = (hit, miss) => hit == null || miss == null ? '—' : `${compactNumber(hit)} / ${compactNumber(miss)}`;
  const stageLabel = purpose => ({ memory_interpretation: '记忆解释', tool_planning: '工具规划',
    answer: '最终回答', compaction: '上下文压缩', legacy: '历史记录', unknown: '未知阶段' }[purpose] || purpose || '未知阶段');

  function headers() {
    return window.SiteUtils?.authHeaders?.() || { Accept: 'application/json' };
  }

  function showNotice(message) {
    const node = $('#notice');
    node.textContent = message;
    node.hidden = !message;
  }

  function renderMetrics(data) {
    const o = data.overview || {};
    const feedback = data.answerFeedback || {};
    const rec = data.recommendation || {};
    $('#requests').textContent = number(o.requests);
    $('#requestsHint').textContent = `${number(o.successes)} 次成功 · ${number(o.errors)} 次错误`;
    $('#successRate').textContent = percent(o.successes, o.requests);
    $('#latency').textContent = ms(o.avgLatencyMs);
    $('#modelCalls').textContent = number(o.modelCalls);
    $('#modelCallsHint').textContent = `${number(o.requests)} 个请求 · 平均 ${o.requests ? (Number(o.modelCalls || 0) / Number(o.requests)).toFixed(1) : '0.0'} 次/请求`;
    $('#tokens').textContent = compactNumber(o.totalTokens);
    $('#tokensHint').textContent = `${compactNumber(o.inputTokens)} 输入 · ${compactNumber(o.outputTokens)} 输出`;
    $('#toolCalls').textContent = number(o.toolCalls);
    $('#fallbacks').textContent = `降级 ${number(o.fallbacks)} 次 · 平均 ${Number(o.avgRounds || 0).toFixed(1)} 轮`;
    $('#answerQuality').textContent = percent(feedback.positive, feedback.total);
    $('#answerFeedbackHint').textContent = feedback.total ? `${number(feedback.positive)} 正向 · ${number(feedback.negative)} 负向` : '暂无用户反馈';
    $('#recommendRate').textContent = percent(rec.clicks, rec.impressions);
    $('#recommendHint').textContent = `${number(rec.impressions)} 次曝光 · ${number(rec.plays)} 次播放`;
    $('#updatedAt').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  }

  function renderDonut(node, items, label) {
    const normalized = items.filter(item => Number(item.value) > 0);
    const total = normalized.reduce((sum, item) => sum + Number(item.value), 0);
    if (!total) {
      node.innerHTML = '<div class="empty">暂无数据</div>';
      return;
    }
    const colors = ['#ff7a18', '#65a9ff', '#39d98a', '#bc8cff', '#ff6b6b', '#f2cc60'];
    let cursor = 0;
    const slices = normalized.map((item, index) => {
      const start = cursor;
      cursor += Number(item.value) / total * 360;
      return `${colors[index % colors.length]} ${start}deg ${cursor}deg`;
    }).join(',');
    node.innerHTML = `<div class="donut" style="background:conic-gradient(${slices})"><strong>${compactNumber(total)}</strong><small>${escapeHtml(label)}</small></div>
      <div class="legend">${normalized.map((item, index) => `<div class="legend-row"><span><i class="legend-dot" style="background:${colors[index % colors.length]}"></i>${escapeHtml(item.label)}</span><b>${number(item.value)}</b></div>`).join('')}</div>`;
  }

  function renderCharts(data) {
    const status = data.statusBreakdown || {};
    renderDonut($('#statusChart'), [
      { label: '成功', value: status.success },
      { label: '错误', value: status.error },
      { label: '降级', value: data.overview?.fallbacks }
    ], '请求');

    const models = Array.isArray(data.models) ? data.models : [];
    renderDonut($('#modelChart'), models.map(item => ({ label: item.model, value: item.calls })), '调用');

    const tokenNode = $('#tokenChart');
    if (!models.length || !models.some(item => Number(item.totalTokens))) {
      tokenNode.innerHTML = '<div class="empty">暂无 Token 使用数据</div>';
      return;
    }
    const max = Math.max(...models.map(item => Number(item.totalTokens) || 0), 1);
    tokenNode.innerHTML = models.map(item => {
      const input = Number(item.inputTokens) || 0;
      const output = Number(item.outputTokens) || 0;
      const total = input + output || Number(item.totalTokens) || 0;
      return `<div class="token-row"><span class="token-name" title="${escapeHtml(item.model)}">${escapeHtml(item.model)}</span><span class="token-stack"><i class="token-in" style="width:${Math.max(input ? 2 : 0, input / max * 100)}%"></i><i class="token-out" style="width:${Math.max(output ? 2 : 0, output / max * 100)}%"></i></span><span class="token-value">${compactNumber(total)}</span></div>`;
    }).join('') + '<div class="token-legend"><i></i>输入 <i></i>输出</div>';
  }

  function renderCacheUsage(models) {
    const node = $('#cacheUsage');
    if (!node) return;
    const rows = (models || []).flatMap(model => (model.stages || []).map(stage => ({ ...stage, model: model.model })));
    node.innerHTML = rows.length ? rows.map(item => `<tr>
      <td>${escapeHtml(item.model)}</td><td>${escapeHtml(stageLabel(item.purpose))}</td>
      <td>${number(item.calls)} / ${number(item.cacheMeasuredCalls)}</td><td>${cacheRatio(item.cacheHitRatio)}</td>
      <td>${cacheTokens(item.cacheHitTokens, item.cacheMissTokens)}</td>
      <td>${measuredMs(item.avgFirstTokenMs)}</td><td>${measuredMs(item.avgFirstTextMs)}</td>
    </tr>`).join('') : '<tr><td colspan="7" class="empty">暂无缓存统计</td></tr>';
  }

  function renderTrend(items) {
    const node = $('#trend');
    if (!items?.length) { node.innerHTML = '<div class="empty">当前时间范围内暂无运行记录</div>'; return; }
    const max = Math.max(...items.map(item => Number(item.requests) || 0), 1);
    node.innerHTML = items.map(item => `<div class="trend-row">
      <span class="day">${escapeHtml(item.day)}</span>
      <span class="trend-bar"><i style="width:${Math.max(2, (Number(item.requests) || 0) / max * 100)}%"></i></span>
      <span class="num">${number(item.requests)} 次</span>
      <span class="num latency">${ms(item.avgLatencyMs)}</span>
    </div>`).join('');
  }

  function renderTools(items) {
    const node = $('#tools');
    if (!items?.length) { node.innerHTML = '<tr><td colspan="4" class="empty">暂无工具调用</td></tr>'; return; }
    node.innerHTML = items.map(item => `<tr>
      <td><strong>${escapeHtml(item.name)}</strong></td><td>${number(item.calls)}</td>
      <td>${percent(item.successes, item.calls)}</td><td>${ms(item.avgDurationMs)}</td>
    </tr>`).join('');
  }

  function renderFunnel(rec) {
    const items = [
      ['曝光', rec.impressions], ['点击', rec.clicks], ['详情', rec.detailViews],
      ['播放', rec.plays], ['收藏', rec.favorites], ['不感兴趣', rec.notInterested]
    ];
    const max = Math.max(Number(rec.impressions) || 0, 1);
    $('#recommendationFunnel').innerHTML = items.map(([label, value]) => `<div class="funnel-item">
      <span>${label}</span><span class="funnel-bar"><i style="width:${Math.max(2, Number(value) / max * 100)}%"></i></span><strong>${number(value)}</strong>
    </div>`).join('');
  }

  function statusLabel(status) {
    const labels = { success: '成功', error: '错误', cancelled: '已取消', running: '进行中' };
    return `<span class="status ${escapeHtml(status)}">${labels[status] || escapeHtml(status || '未知')}</span>`;
  }

  function renderRuns(items) {
    const node = $('#runs');
    if (!items?.length) { node.innerHTML = '<tr><td colspan="7" class="empty">暂无运行记录</td></tr>'; return; }
    node.innerHTML = items.map(item => `<tr data-run-id="${escapeHtml(item.run_id)}">
      <td>${escapeHtml(date(item.started_at))}</td><td>${escapeHtml(item.username || (item.user_id ? `用户 #${item.user_id}` : '访客'))}</td>
      <td>${statusLabel(item.status)}</td><td>${ms(item.duration_ms)}</td><td>${number(item.rounds)}</td>
      <td>${number(item.tool_calls)}</td><td>${number(item.cards_count)}</td>
    </tr>`).join('');
    node.querySelectorAll('[data-run-id]').forEach(row => row.addEventListener('click', () => openRun(row.dataset.runId)));
  }

  async function openRun(runId) {
    const dialog = $('#runDialog');
    const node = $('#runDetail');
    node.innerHTML = '<div class="empty">正在加载运行详情…</div>';
    dialog.showModal();
    try {
      const response = await fetch(`/api/admin/agent/runs/${encodeURIComponent(runId)}`, { headers: headers(), cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
      const run = data.run;
      node.innerHTML = `<h2 class="detail-title">运行详情</h2>
        <div class="detail-grid">
          <div class="detail-cell"><small>运行标识</small><strong>${escapeHtml(run.run_id)}</strong></div>
          <div class="detail-cell"><small>用户</small><strong>${escapeHtml(run.username || (run.user_id ? `用户 #${run.user_id}` : '访客'))}</strong></div>
          <div class="detail-cell"><small>状态</small><strong>${statusLabel(run.status)}</strong></div>
          <div class="detail-cell"><small>模型</small><strong>${escapeHtml(run.model || '—')}</strong></div>
          <div class="detail-cell"><small>耗时</small><strong>${ms(run.duration_ms)}</strong></div>
          <div class="detail-cell"><small>输入 / 输出</small><strong>${number(run.input_chars)} / ${number(run.answer_chars)} 字</strong></div>
          <div class="detail-cell"><small>模型调用</small><strong>${number(run.model_calls)}</strong></div>
          <div class="detail-cell"><small>Token</small><strong>${compactNumber(run.total_tokens)}（${compactNumber(run.input_tokens)} / ${compactNumber(run.output_tokens)}）</strong></div>
        </div>
        <section class="detail-section"><h3>模型调用（${number(run.models?.length)}）</h3>
          ${run.models?.length ? run.models.map(model => `<div class="tool-event"><strong>${escapeHtml(model.model || 'unknown')}</strong> · ${escapeHtml(stageLabel(model.purpose))} · ${statusLabel(model.status)} · ${ms(model.duration_ms)} · ${compactNumber(model.total_tokens)} Token${model.tokens_estimated ? '（含估算）' : ''}
            <div class="muted">缓存命中 / 未命中：${cacheTokens(model.cache_hit_tokens, model.cache_miss_tokens)} · 首 Token：${measuredMs(model.first_token_ms)} · 首段正文：${measuredMs(model.first_text_ms)}</div></div>`).join('') : '<div class="empty">没有模型调用明细</div>'}
        </section>
        <section class="detail-section"><h3>工具调用（${number(run.tools?.length)}）</h3>
          ${run.tools?.length ? run.tools.map(tool => `<div class="tool-event"><strong>${escapeHtml(tool.name)}</strong> · ${statusLabel(tool.status)} · ${ms(tool.duration_ms)}
            <pre>${escapeHtml(tool.result_summary || tool.error_code || tool.args_json || '')}</pre></div>`).join('') : '<div class="empty">本次没有调用工具</div>'}
        </section>
        <section class="detail-section"><h3>回答反馈</h3>
          ${run.feedback?.length ? run.feedback.map(item => `<span class="feedback-pill">${escapeHtml(item.rating)}${item.reason ? ` · ${escapeHtml(item.reason)}` : ''}</span>`).join('') : '<div class="empty">暂无回答反馈</div>'}
        </section>`;
    } catch (error) {
      node.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
  }

  async function load() {
    const days = $('#range').value;
    $('#refresh').disabled = true;
    showNotice('');
    try {
      const response = await fetch(`/api/admin/agent/overview?days=${encodeURIComponent(days)}`, { headers: headers(), cache: 'no-store' });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
      renderMetrics(data); renderCharts(data); renderTrend(data.trend); renderTools(data.tools); renderFunnel(data.recommendation || {}); renderRuns(data.runs);
      renderCacheUsage(data.models);
    } catch (error) {
      showNotice(`${error.message}。如果是 403，请在服务端配置 AGENT_ADMIN_USER_IDS 或 AGENT_ADMIN_EMAILS。`);
    } finally {
      $('#refresh').disabled = false;
    }
  }

  $('#range').addEventListener('change', load);
  $('#refresh').addEventListener('click', load);
  load();
}());
