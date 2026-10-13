function escapePromptData(value) {
  return String(value || '')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function untrustedDataBlock(name, value) {
  const safeName = String(name || 'data').replace(/[^a-z0-9_-]/gi, '_');
  return `<untrusted_${safeName}>\n${escapePromptData(value)}\n</untrusted_${safeName}>`;
}

module.exports = { escapePromptData, untrustedDataBlock };
