function validate(value, schema, path = 'args') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} 必须是对象`;
    for (const key of schema.required || []) if (value[key] === undefined) return `${path}.${key} 缺失`;
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) return `${path}.${key} 是未知参数`;
      const error = validate(item, schema.properties[key], `${path}.${key}`);
      if (error) return error;
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} 必须是数组`;
    if (value.length < (schema.minItems || 0) || value.length > (schema.maxItems || 30)) return `${path} 数量不合法`;
    for (const item of value) { const error = validate(item, schema.items, path); if (error) return error; }
  } else if (schema.type === 'integer') {
    if (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${path} 数值不合法`;
  } else if (typeof value !== schema.type) return `${path} 类型不合法`;
  if (schema.type === 'string' && (value.length > (schema.maxLength ?? 2000) || value.length < (schema.minLength ?? 0))) return `${path} 长度不合法`;
  if (schema.enum && !schema.enum.includes(value)) return `${path} 不在允许范围`;
  return '';
}

module.exports = { validate };
