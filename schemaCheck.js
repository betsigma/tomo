// schemaCheck.js
// ---------------------------------------------------------------------------
// A small JSON-Schema subset validator for the agent contracts in /schemas.
// Supports: type (string or array, incl. "null"), properties, required, items,
// enum, minItems, maxItems, minLength, maxLength, minimum, maximum.
// Returns a list of readable errors ([] = valid).
// ---------------------------------------------------------------------------

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(v, t) {
  const actual = typeOf(v);
  if (t === 'number') return actual === 'number' || actual === 'integer';
  return actual === t;
}

function validate(schema, value, where = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errors.push(`${where}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${where}: must be one of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`);
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${where}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${where}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${where}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${where}: above ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${where}: needs at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${where}: at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validate(schema.items, item, `${where}[${i}]`, errors));
  }

  if (value && typeOf(value) === 'object') {
    for (const k of (schema.required || [])) {
      if (!(k in value)) errors.push(`${where}: missing "${k}"`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) validate(sub, value[k], `${where}.${k}`, errors);
    }
  }
  return errors;
}

module.exports = { validate };
