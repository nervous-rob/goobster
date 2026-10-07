import type { HostConfigField } from '../../lib/types';
import type { FieldDraft } from './FieldControl';

export type Drafts = Record<string, FieldDraft>;

export function parseValue(field: HostConfigField, draft: FieldDraft): { value?: unknown; invalid?: string } {
    if (draft.action === 'remove') return {};
    const raw = draft.value;
    if (field.type === 'boolean') return { value: raw === true };
    const text = String(raw).trim();
    if (field.secret) return text ? { value: String(raw) } : { invalid: 'Type the new value, or cancel.' };
    if (text === '') return { invalid: 'This needs a value; use "Use the default" to clear it.' };
    if (field.type === 'integer' || field.type === 'number') {
        const number = Number(text);
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) return { invalid: 'This must be a number.' };
        if (field.min !== undefined && number < field.min) return { invalid: `The smallest value is ${field.min}.` };
        if (field.max !== undefined && number > field.max) return { invalid: `The largest value is ${field.max}.` };
        return { value: number };
    }
    if (field.type === 'list') return { value: text.split(',').map((item) => item.trim()).filter(Boolean) };
    return { value: text };
}

/** Drafts to the manager's `changes`, or the first thing wrong with them. */
export function buildChanges(fields: Map<string, HostConfigField>, drafts: Drafts): { changes: Array<Record<string, unknown>>; problem: string | null } {
    const changes: Array<Record<string, unknown>> = [];
    let problem: string | null = null;
    for (const [id, draft] of Object.entries(drafts)) {
        const field = fields.get(id);
        if (!field) continue;
        const parsed = parseValue(field, draft);
        if (parsed.invalid) {
            problem = `${id}: ${parsed.invalid}`;
            continue;
        }
        changes.push(draft.action === 'remove' ? { id, action: 'remove' } : { id, action: 'set', value: parsed.value });
    }
    return { changes, problem };
}

