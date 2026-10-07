/**
 * A small JSON Schema checker for the answers file: the keywords
 * answers.schema.json uses (type, enum, const, properties, required,
 * additionalProperties, items, minItems, maxItems, minLength, maxLength,
 * pattern, oneOf, local $ref). Problems name a JSON pointer and a rule,
 * never the value, so a secret in a rejected file is not echoed.
 */

const TYPES = {
    object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
    array: Array.isArray,
    string: (value) => typeof value === 'string',
    boolean: (value) => typeof value === 'boolean',
    number: (value) => typeof value === 'number' && Number.isFinite(value),
    integer: (value) => Number.isInteger(value)
};

function resolveRef(root, ref) {
    if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
    return ref.slice(2).split('/').reduce((node, key) => node[key], root);
}

function check(root, schema, value, pointer, problems) {
    if (schema.$ref) return check(root, resolveRef(root, schema.$ref), value, pointer, problems);
    if (schema.oneOf) {
        const matches = schema.oneOf.filter((branch) => {
            const inner = [];
            check(root, branch, value, pointer, inner);
            return inner.length === 0;
        });
        if (matches.length !== 1) problems.push({ pointer, rule: 'oneOf' });
        return undefined;
    }
    if (schema.const !== undefined && value !== schema.const) problems.push({ pointer, rule: 'const' });
    if (schema.enum && !schema.enum.includes(value)) problems.push({ pointer, rule: 'enum' });
    if (schema.type && !TYPES[schema.type](value)) {
        problems.push({ pointer, rule: `type:${schema.type}` });
        return undefined;
    }
    if (typeof value === 'string') {
        if (schema.minLength !== undefined && value.length < schema.minLength) problems.push({ pointer, rule: 'minLength' });
        if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push({ pointer, rule: 'maxLength' });
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) problems.push({ pointer, rule: 'pattern' });
    }
    if (Array.isArray(value)) {
        if (schema.minItems !== undefined && value.length < schema.minItems) problems.push({ pointer, rule: 'minItems' });
        if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push({ pointer, rule: 'maxItems' });
        if (schema.items) value.forEach((item, index) => check(root, schema.items, item, `${pointer}/${index}`, problems));
    }
    if (TYPES.object(value) && (schema.properties || schema.required || schema.additionalProperties === false)) {
        for (const key of schema.required || []) if (!(key in value)) problems.push({ pointer: `${pointer}/${key}`, rule: 'required' });
        for (const [key, inner] of Object.entries(value)) {
            const rule = schema.properties && schema.properties[key];
            if (rule) check(root, rule, inner, `${pointer}/${key}`, problems);
            else if (schema.additionalProperties === false) problems.push({ pointer: `${pointer}/${key}`, rule: 'additionalProperties' });
        }
    }
    return undefined;
}

/** @returns {Array<{ pointer: string, rule: string }>} empty when `value` satisfies `schema` (or its `definitions[name]`) */
function validate(schema, value, { definition = null } = {}) {
    const problems = [];
    const target = definition ? schema.definitions[definition] : schema;
    check(schema, target, value, '', problems);
    return problems;
}

module.exports = { validate };
