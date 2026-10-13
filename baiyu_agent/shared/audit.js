// Tool arguments may contain user quotations or credentials. Audit shape, never raw prose.
function auditArguments(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { invalidShape: true };
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key,
    typeof value === 'string' ? { chars: value.length } : Array.isArray(value) ? { count: value.length }
      : typeof value === 'number' || typeof value === 'boolean' ? value : { supplied: value != null }]));
}

module.exports = { auditArguments };
