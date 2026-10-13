const TOOL_MARKER_RE = /<\|(?:DSML|tool_calls?|invoke|parameter|function|im_start|im_end)[^>]*>|<\|[^>]+\|>/gi;

function normalizeContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : part?.text || '').join('').trim();
  }
  return '';
}

function stripToolProtocol(content) {
  let text = normalizeContent(content);
  const protocolStart = text.search(/<\|(?:DSML|tool_calls?|invoke)\b/i);
  if (protocolStart >= 0) text = text.slice(0, protocolStart).trim();
  text = text
    .replace(/<\|DSML\|>[\s\S]*?<\|\/\|DSML\|>/gi, '')
    .replace(/<\|tool_calls\|>[\s\S]*?<\|\/\|tool_calls\|>/gi, '')
    .replace(/<\|invoke[\s\S]*?<\|\/\|invoke\|>/gi, '')
    .replace(TOOL_MARKER_RE, '')
    .replace(/\b(?:tool_calls?|invoke|parameter)\s+name\s*=\s*["'][^"']+["'][^\n]*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text;
}

function isToolProtocolText(content) {
  const text = normalizeContent(content);
  return /<\|(?:DSML|tool_calls?|invoke|parameter)\|>|<\|DSML\|>|\btool_calls?\b.*\binvoke\b/i.test(text);
}

// Diagnostic parser only. Providers never execute tool tags from ordinary text.
function parseLegacyToolCalls(content) {
  const text = normalizeContent(content).replace(/<\|DSML\|>/gi, '');
  if (!/^\s*<\|invoke\b/i.test(text) || /```/.test(text)) return [];
  const calls = [];
  const invokeRe = /(?:<\|DSML\|>)?\s*<\|invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)(?:<\|\/\|invoke\|>|<\/\|invoke\|>|<\/\|invoke>|<\|\/invoke\|>)/gi;
  for (const match of text.matchAll(invokeRe)) {
    const args = {};
    const block = match[2] || '';
    const parameterRe = /(?:<\|DSML\|>)?\s*<\|parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?\s*>([\s\S]*?)(?:<\|\/\|parameter\|>|<\/\|parameter\|>|<\/\|parameter>|<\|\/parameter\|>)/gi;
    for (const parameter of block.matchAll(parameterRe)) {
      const key = parameter[1];
      const raw = String(parameter[3] || '').trim();
      const isString = String(parameter[2] || '').toLowerCase() !== 'false';
      if (isString) args[key] = raw;
      else { try { args[key] = JSON.parse(raw); } catch (_) { args[key] = raw; } }
    }
    calls.push({ id: 'legacy_' + require('crypto').randomUUID(), type: 'function', function: { name: match[1], arguments: JSON.stringify(args) } });
  }
  return calls;
}

module.exports = { normalizeContent, stripToolProtocol, isToolProtocolText, parseLegacyToolCalls };
