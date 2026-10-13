const { stripToolProtocol, isToolProtocolText } = require('../core/message');
const { strictToolSchemas } = require('../tools/schemas');
const { fetchJson, scopedSignal, throwIfAborted, retry } = require('../shared/runtime');

class AgentProvider {
  constructor(env = process.env) {
    this.baseUrl = String(env.LLM_BASE_URL || '').replace(/\/$/, '');
    this.apiKey = String(env.LLM_API_KEY || '');
    this.model = String(env.LLM_MODEL || '');
    this.timeoutMs = Math.max(3000, Number(env.AGENT_TIMEOUT_MS) || 25000);
    this.maxTokens = Math.max(200, Number(env.AGENT_MAX_TOKENS) || 2000);
    // Explicit deployment capability; an arbitrary model alias cannot prove a window size.
    this.contextWindow = Math.max(0, Number(env.LLM_CONTEXT_WINDOW) || 0);
    this.strictTools = String(env.LLM_TOOL_STRICT || '').toLowerCase() === 'true';
    // Forced function selection is opt-in for the configured provider endpoint.
    this.supportsForcedTools = ['1', 'true', 'yes'].includes(String(env.LLM_FORCE_TOOL_CHOICE || '').toLowerCase());
    const toolChoiceFlag = String(env.LLM_TOOL_CHOICE_NONE || '').toLowerCase();
    this.supportsToolChoiceNone = toolChoiceFlag
      ? ['1', 'true', 'yes'].includes(toolChoiceFlag)
      : /(^|\.)deepseek\.com$/i.test(hostnameOf(this.baseUrl));
    const thinkingFlag = String(env.LLM_DISABLE_THINKING || '').toLowerCase();
    this.disableThinking = thinkingFlag
      ? !['0', 'false', 'no'].includes(thinkingFlag)
      : /deepseek\.com/i.test(this.baseUrl);
  }

  isConfigured() {
    return Boolean(this.baseUrl && this.model);
  }

  endpoint() {
    if (/\/chat\/completions$/i.test(this.baseUrl)) return this.baseUrl;
    return `${this.baseUrl}/chat/completions`;
  }

  payload(messages, tools, stream, maxTokens, toolChoice) {
    const payload = { model: this.model, messages, temperature: 0.25, max_tokens: maxTokens || this.maxTokens, stream };
    if (tools?.length) { payload.tools = this.strictTools ? strictToolSchemas(tools) : tools; payload.tool_choice = toolChoice || 'auto'; }
    if (this.disableThinking) payload.thinking = { type: 'disabled' };
    return payload;
  }

  headers(stream = false) {
    return { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async chat({ messages, tools = [], signal, maxTokens, toolChoice }) {
    if (!this.isConfigured()) throw new Error('MODEL_NOT_CONFIGURED');
    const { data } = await fetchJson(this.endpoint(), {
      method: 'POST', headers: this.headers(), signal,
      body: JSON.stringify(this.payload(messages, tools, false, maxTokens, toolChoice))
    }, { timeoutMs: this.timeoutMs });
    const choice = data?.choices?.[0];
    if (['length', 'content_filter'].includes(choice?.finish_reason)) throw new Error(`MODEL_INCOMPLETE_${choice.finish_reason}`);
    const message = choice?.message;
    if (!message) throw new Error('MODEL_EMPTY_RESPONSE');
    const toolCalls = message.tool_calls || [];
    if (toolChoice === 'none' && toolCalls.length) throw new Error('MODEL_UNEXPECTED_TOOL_CALL');
    if (!toolCalls.length && isToolProtocolText(message.content)) throw new Error('MODEL_NATIVE_TOOL_CALLS_REQUIRED');
    if (!message.content && !toolCalls.length) throw new Error('MODEL_EMPTY_RESPONSE');
    return { ...message, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), usage: data.usage || null };
  }

  async chatStream({ messages, tools = [], signal, onDelta, maxTokens, toolChoice }) {
    if (!this.isConfigured()) throw new Error('MODEL_NOT_CONFIGURED');
    const scope = scopedSignal(signal, this.timeoutMs);
    const started = Date.now();
    let firstTokenMs = null;
    let reader;
    try {
      const response = await retry(async () => {
        const result = await fetch(this.endpoint(), {
          method: 'POST', headers: this.headers(true), signal: scope.signal,
          body: JSON.stringify(this.payload(messages, tools, true, maxTokens, toolChoice))
        });
        if (!result.ok) {
          await result.body?.cancel();
          const error = new Error(`MODEL_HTTP_${result.status}`);
          error.status = result.status;
          throw error;
        }
        return result;
      }, { signal: scope.signal });
      if (!response.body) throw new Error('MODEL_EMPTY_RESPONSE');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', content = '', reasoning = '', emitted = 0, usage = null, terminal = false, doneMarker = false, finishReason = '';
      const calls = new Map();
      const emitSafe = (final = false) => {
        // Hold a possible protocol prefix across chunks; only final text is authoritative.
        const marker = content.indexOf('<|');
        const safe = marker >= 0 ? content.slice(0, marker) : content.slice(0, final ? content.length : Math.max(0, content.length - 64));
        if (safe.length > emitted) { onDelta?.(safe.slice(emitted)); emitted = safe.length; }
      };
      const consume = line => {
        if (!line.trim().startsWith('data:')) return;
        const raw = line.trim().slice(5).trim();
        if (raw === '[DONE]') { terminal = true; doneMarker = true; return; }
        if (!raw) return;
        const item = JSON.parse(raw);
        if (item.error) throw new Error('MODEL_STREAM_ERROR');
        if (item.usage) usage = item.usage;
        const choice = item.choices?.[0];
        if (choice?.finish_reason) { finishReason = choice.finish_reason; terminal = true; }
        const delta = choice?.delta;
        if ((!tools.length || toolChoice === 'none') && delta?.tool_calls?.length) throw new Error('MODEL_UNEXPECTED_TOOL_CALL');
        if (firstTokenMs === null && (delta?.content || delta?.reasoning_content
          || delta?.tool_calls?.some(part => part.function?.name || part.function?.arguments))) firstTokenMs = Date.now() - started;
        if (typeof delta?.reasoning_content === 'string') reasoning += delta.reasoning_content;
        if (typeof delta?.content === 'string') { content += delta.content; emitSafe(); }
        for (const part of delta?.tool_calls || []) {
          if (!Number.isInteger(part.index) || part.index < 0) throw new Error('MODEL_TOOL_DELTA_INVALID');
          const call = calls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (part.id && call.id && part.id !== call.id) throw new Error('MODEL_TOOL_ID_CHANGED');
          if (part.type && part.type !== 'function') throw new Error('MODEL_TOOL_TYPE_INVALID');
          if (part.id) call.id = part.id;
          if (part.function?.name) call.function.name += part.function.name;
          if (part.function?.arguments) call.function.arguments += part.function.arguments;
          calls.set(part.index, call);
        }
      };
      while (true) {
        throwIfAborted(scope.signal);
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) consume(line);
        if (done || doneMarker) break;
      }
      if (buffer.trim()) consume(buffer);
      if (!terminal || ['length', 'content_filter'].includes(finishReason)) throw new Error('MODEL_STREAM_INCOMPLETE');
      const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call);
      if (!toolCalls.length && isToolProtocolText(content)) throw new Error('MODEL_NATIVE_TOOL_CALLS_REQUIRED');
      const answer = stripToolProtocol(content);
      if (!answer && !toolCalls.length) throw new Error('MODEL_EMPTY_RESPONSE');
      emitSafe(true);
      return { content: answer, tool_calls: toolCalls, usage, streamed: true, firstTokenMs,
        ...(toolCalls.length && reasoning ? { reasoning_content: reasoning } : {}) };
    } catch (error) {
      throwIfAborted(scope.signal);
      throw error;
    } finally {
      await reader?.cancel().catch(() => {});
      scope.dispose();
    }
  }
}

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}

module.exports = { AgentProvider };
