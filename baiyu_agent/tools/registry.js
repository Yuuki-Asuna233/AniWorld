const { validate } = require('./validation');
const { throwIfAborted } = require('../shared/runtime');
const { TOOL_SPECS, argumentError, normalizeResult } = require('./contracts');

class ToolRegistry {
  constructor(schemas = [], executor = null) {
    this.schemas = schemas;
    this.executor = executor;
    this.byName = new Map(schemas.map(schema => [schema?.function?.name, schema]));
    if (this.byName.size !== schemas.length || schemas.some(schema => !TOOL_SPECS[schema.function?.name])) throw new Error('TOOL_REGISTRY_INVALID');
  }

  names() { return [...this.byName.keys()].filter(Boolean); }
  schemasFor(names = null) {
    if (!names) return this.schemas;
    const allowed = new Set(names);
    return this.schemas.filter(schema => allowed.has(schema?.function?.name));
  }
  has(name) { return this.byName.has(name); }
  spec(name) { return TOOL_SPECS[name]; }
  normalizeArguments(name, args) {
    const schema = this.byName.get(name)?.function.parameters;
    if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) return args;
    return Object.fromEntries(Object.entries(args).filter(([key, value]) => !(value === null && Object.hasOwn(schema.properties, key) && !(schema.required || []).includes(key))));
  }
  available(context = {}) { return this.schemas.filter(schema => !this.spec(schema.function.name).auth || context.userId); }
  async execute(name, args, context) {
    throwIfAborted(context?.signal);
    if (!this.has(name) || typeof this.executor !== 'function') throw new Error(`UNKNOWN_TOOL: ${name}`);
    args = this.normalizeArguments(name, args);
    const error = validate(args, this.byName.get(name).function.parameters) || argumentError(name, args);
    if (error) return normalizeResult({ error, policyRejected: true, errorCode: 'INVALID_ARGUMENTS' });
    if (this.spec(name).auth && !context?.userId) return normalizeResult({ requiresLogin: true, policyRejected: true, error: '该工具需要登录。', errorCode: 'LOGIN_REQUIRED' });
    return normalizeResult(await this.executor(name, args, context));
  }
}

module.exports = { ToolRegistry };
