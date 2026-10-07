import { useState } from 'react';
import type { HostConfigField, HostConfigReport, HostProbeOutcome } from '../../lib/types';
import { failureOf, HelpLink, SourceBadge } from './shared';
import { useProbe } from './transport';

export type FieldDraft = { action: 'set'; value: string | boolean } | { action: 'remove' };
export type ProbeTarget = HostConfigReport['probes'][number];

export const PROBE_FIELD: Record<string, string> = {
    'ai.openai.apiKey': 'openai',
    'ai.anthropic.apiKey': 'anthropic',
    'ai.gemini.apiKey': 'gemini',
    'perplexity.apiKey': 'perplexity',
    'elevenlabs.apiKey': 'elevenlabs',
    'github.token': 'github',
    'cursor.apiKey': 'cursor',
    'ollama.host': 'ollama',
    'mail.smtp.host': 'mail'
};

const PROBE_CODE_TEXT: Record<string, string> = {
    OK: 'It works.',
    AUTH_FAILED: 'The provider refused the credential.',
    UNREACHABLE: 'Nothing answered.',
    TIMEOUT: 'It did not answer in time.',
    RATE_LIMITED: 'The provider is rate limiting this key; try again shortly.',
    UNKNOWN: 'The provider gave an answer this page does not understand.'
};

/** The current value of a non-secret field as the text an input shows. */
export function textOf(field: HostConfigField): string {
    const value = field.value;
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
}

function ProbeControl({ field, probe, typed }: { field: HostConfigField; probe: ProbeTarget; typed: string }) {
    const [outcome, setOutcome] = useState<HostProbeOutcome | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const runProbe = useProbe();
    const usingTyped = probe.needsCredential && typed.length > 0;
    const canRun = usingTyped || field.present || !probe.needsCredential;

    async function run() {
        setBusy(true);
        setOutcome(null);
        setError(null);
        try {
            setOutcome(await runProbe(usingTyped ? { target: probe.target, credential: typed } : { target: probe.target, useSaved: true }));
        } catch (cause) {
            setError(failureOf(cause).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div data-testid="probe">
            <button type="button" className="btn small" onClick={() => void run()} disabled={busy || !canRun} data-testid="probe-run">
                {busy ? 'Testing…' : 'Test connection'}
            </button>
            <div className="hint">
                {probe.whatItDoes}{probe.sendsCredentialTo ? ` The key goes to ${probe.sendsCredentialTo} only.` : ''}
                {' '}{usingTyped ? 'It tests the value you typed.' : (probe.needsCredential ? 'It tests the saved key.' : 'It tests the saved setting.')} It is a check, not a save.
            </div>
            <div role="status" aria-live="polite" data-testid="probe-result">
                {outcome && (
                    <span className={outcome.ok ? undefined : 'settings-danger'} data-ok={outcome.ok}>
                        <strong>{outcome.ok ? 'Connected.' : 'Not connected.'}</strong> {PROBE_CODE_TEXT[outcome.code] || outcome.detail}
                        {outcome.ok && outcome.latencyMs !== undefined ? ` (${outcome.latencyMs} ms)` : ''}
                    </span>
                )}
                {error && <span className="settings-danger">{error}</span>}
            </div>
        </div>
    );
}

/**
 * One catalog field. A secret shows only the manager's fingerprint and
 * source; Replace opens a password box whose value lives in the page's draft
 * until the preview succeeds, then is dropped. An environment-controlled
 * field is read-only and names the variable.
 */
export function FieldControl({ field, draft, setDraft, readOnly, probe }: {
    field: HostConfigField;
    draft: FieldDraft | undefined;
    setDraft: (draft: FieldDraft | null) => void;
    readOnly: string | null;
    probe?: ProbeTarget;
}) {
    const inputId = `host-field-${field.id}`;
    const typed = draft && draft.action === 'set' && typeof draft.value === 'string' && field.secret ? draft.value : '';
    const removing = draft?.action === 'remove';
    const replacing = Boolean(field.secret) && draft?.action === 'set';

    return (
        <li className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}
            data-testid="host-field" data-field={field.id} data-source={field.source} data-env={field.envControlled}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <label htmlFor={inputId}><code>{field.id}</code></label>
                <span>
                    <SourceBadge source={field.source} />
                    <span className="badge" title={field.apply === 'hot' ? 'Read on every request' : 'Read when the process starts'}>
                        {field.apply === 'hot' ? 'Takes effect immediately' : 'Needs a restart'}
                    </span>
                </span>
            </div>
            {field.description && <span className="hint">{field.description}</span>}

            {field.secret ? (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span data-testid="secret-state" data-present={field.present}>
                        {field.present
                            ? <>Set{field.fingerprint ? <> · ends in <code data-testid="fingerprint">{field.fingerprint}</code></> : null}</>
                            : 'Not set'}
                    </span>
                    {!readOnly && !replacing && !removing && (
                        <button type="button" className="btn small" data-testid="secret-replace"
                            onClick={() => setDraft({ action: 'set', value: '' })}>
                            {field.present ? 'Replace' : 'Set'}
                        </button>
                    )}
                    {!readOnly && field.present && !replacing && !removing && field.source === 'config' && (
                        <button type="button" className="btn small" data-testid="secret-remove" onClick={() => setDraft({ action: 'remove' })}>Remove</button>
                    )}
                    {removing && (
                        <>
                            <span className="settings-danger" data-testid="secret-removing">Will be removed when you preview and apply.</span>
                            <button type="button" className="btn small subtle" onClick={() => setDraft(null)}>Keep it</button>
                        </>
                    )}
                    {replacing && (
                        <>
                            <input id={inputId} className="input" type="password" autoComplete="off" spellCheck={false}
                                aria-label={`New value for ${field.id}`} value={typed}
                                onChange={(event) => setDraft({ action: 'set', value: event.target.value })} data-testid="secret-input" style={{ flex: 1, minWidth: 220 }} />
                            <button type="button" className="btn small subtle" onClick={() => setDraft(null)}>Cancel</button>
                        </>
                    )}
                </div>
            ) : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    {field.type === 'boolean' ? (
                        <label>
                            <input id={inputId} type="checkbox" disabled={Boolean(readOnly)}
                                checked={draft && draft.action === 'set' ? draft.value === true : field.value === true}
                                onChange={(event) => setDraft({ action: 'set', value: event.target.checked })} data-testid="field-input" />
                            {' '}{(draft && draft.action === 'set' ? draft.value === true : field.value === true) ? 'On' : 'Off'}
                        </label>
                    ) : field.options && field.options.length > 0 ? (
                        <select id={inputId} className="select" disabled={Boolean(readOnly)} data-testid="field-input"
                            value={draft && draft.action === 'set' ? String(draft.value) : textOf(field)}
                            onChange={(event) => setDraft({ action: 'set', value: event.target.value })}>
                            {!field.options.includes(textOf(field)) && <option value="">Not set</option>}
                            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                        </select>
                    ) : (
                        <input id={inputId} className="input" disabled={Boolean(readOnly)} data-testid="field-input"
                            type={field.type === 'integer' || field.type === 'number' ? 'number' : 'text'}
                            min={field.min} max={field.max} spellCheck={false}
                            value={draft && draft.action === 'set' ? String(draft.value) : textOf(field)}
                            onChange={(event) => setDraft({ action: 'set', value: event.target.value })} style={{ flex: 1, minWidth: 220 }} />
                    )}
                    {!readOnly && (field.source === 'config' || field.source === 'db') && !removing && (
                        <button type="button" className="btn small subtle" data-testid="field-reset" onClick={() => setDraft({ action: 'remove' })}>Use the default</button>
                    )}
                    {removing && (
                        <>
                            <span className="settings-danger" data-testid="field-removing">Will go back to the default when you apply.</span>
                            <button type="button" className="btn small subtle" onClick={() => setDraft(null)}>Keep it</button>
                        </>
                    )}
                    {field.default !== undefined && field.default !== null && <span className="hint">Default: {String(field.default)}</span>}
                </div>
            )}

            {readOnly && <span className="hint" data-testid="field-readonly">{readOnly}</span>}
            {probe && <ProbeControl field={field} probe={probe} typed={typed} />}
            <HelpLink help={field.help} />
        </li>
    );
}
