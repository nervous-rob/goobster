import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['chat']['values'];
type Provider = { key: string; name: string; configured: boolean; isDefault?: boolean; chatModel?: string | null; thoughtfulModel?: string | null; reasoningEffort?: boolean };
type Draft = { provider: string; model: string; reasoningEffort: string; thoughtful: boolean };

const REASONING = [
    { value: '', label: 'Default' },
    { value: 'minimal', label: 'Minimal' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' }
];

const toDraft = (v: Values): Draft => ({
    provider: v.provider || '',
    model: v.model || '',
    reasoningEffort: v.reasoningEffort || '',
    thoughtful: Boolean(v.thoughtful)
});

const LABELS: Record<string, string> = { provider: 'Model platform', model: 'Model', reasoningEffort: 'Reasoning effort' };

export function ChatSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['chat'];
    onDirty: (dirty: boolean) => void;
}) {
    // Thoughtful is staged in the same draft as provider/model/reasoning: the
    // server resolves the preset on save, so cancelling changes nothing.
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        if (draft.thoughtful && !baseline.thoughtful) {
            const out: Record<string, unknown> = { thoughtful: true };
            if ('provider' in diff) out.provider = draft.provider || null;
            return out;
        }
        delete diff.thoughtful;
        for (const key of ['provider', 'model', 'reasoningEffort']) {
            if (key in diff) diff[key] = String(diff[key] ?? '').trim() || null;
        }
        return diff;
    }, []);
    const d = useSectionDraft('chat', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    const providers = (section.providers || []) as Provider[];
    const effective = section.effective as { provider?: string; providerName?: string; model?: string; reasoningEffort?: string | null };
    const hostDefault = providers.find((p) => p.isDefault);
    const entry = providers.find((p) => p.key === (d.draft.provider || hostDefault?.key));
    const supportsReasoning = !entry || entry.reasoningEffort !== false;
    const thoughtfulAvailable = section.thoughtfulAvailable !== false && Boolean(entry?.thoughtfulModel || hostDefault?.thoughtfulModel);

    const [models, setModels] = useState<string[]>([]);
    const [modelsError, setModelsError] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        setModelsError(null);
        api.listModels(d.draft.provider || null).then((result) => {
            if (cancelled) return;
            setModels(((result as { models?: string[] }).models) || []);
        }).catch((error: Error) => {
            if (cancelled) return;
            setModels([]);
            setModelsError(error.message || 'Could not load the model catalog.');
        });
        return () => { cancelled = true; };
    }, [d.draft.provider]);

    function setThoughtful(next: boolean) {
        if (next) {
            const preset = entry?.thoughtfulModel || hostDefault?.thoughtfulModel || '';
            d.set({ thoughtful: true, model: preset, reasoningEffort: 'high' });
        } else {
            d.set({ thoughtful: false, model: '', reasoningEffort: '' });
        }
    }

    function setManual(patch: Partial<Draft>) {
        // Editing the model or reasoning by hand leaves the preset.
        d.set({ ...patch, thoughtful: false });
    }

    const savedModelMissing = d.draft.model && models.length > 0 && !models.includes(d.draft.model);

    return (
        <section className="settings-section" aria-labelledby="settings-chat-title">
            <SectionHeader id="chat" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <div className="settings-effective">
                Currently answering with <strong>{effective.providerName || effective.provider}</strong> · <code>{effective.model}</code>
                {effective.reasoningEffort ? <> · {effective.reasoningEffort} reasoning</> : null}
                {!section.values.provider && !section.values.model && <span className="hint"> (host default)</span>}
            </div>

            <Field id="thoughtful" label="Thoughtful Mode" inline
                hint={thoughtfulAvailable
                    ? 'A preset: the platform\'s deeper model at high reasoning. Slower and pricier; better on hard questions.'
                    : 'Needs a cloud platform with a thoughtful tier configured on this host.'}>
                <button id="thoughtful-input" type="button" className={`toggle${d.draft.thoughtful ? ' on' : ''}`}
                    role="switch" aria-checked={d.draft.thoughtful} aria-label="Thoughtful Mode"
                    disabled={!thoughtfulAvailable}
                    onClick={() => setThoughtful(!d.draft.thoughtful)} />
            </Field>

            <Field id="provider" label="Model platform"
                hint={<>Use host default — currently <strong>{hostDefault?.name || 'auto'}</strong>. Platforms without a key on this host stay listed but can't be chosen.</>}>
                <select id="provider-input" className="select" value={d.draft.provider}
                    onChange={(e) => d.set({ provider: e.target.value, model: '', thoughtful: false })}>
                    <option value="">Host default ({hostDefault?.name || 'auto'})</option>
                    {providers.map((p) => (
                        <option key={p.key} value={p.key} disabled={!p.configured}>
                            {p.configured ? p.name : `${p.name} — not configured here`}
                        </option>
                    ))}
                </select>
            </Field>

            <Field id="model" label="Model"
                hint={entry?.chatModel ? <>Provider default is <code>{entry.chatModel}</code>.</> : 'Leave on the provider default unless you have a reason.'}
                error={modelsError ? `Model list unavailable (${modelsError}). Your saved choice is kept; you can still save other fields.` : null}>
                <select id="model-input" className="select" value={d.draft.model}
                    onChange={(e) => setManual({ model: e.target.value })}>
                    <option value="">{entry?.chatModel ? `Provider default (${entry.chatModel})` : 'Provider default'}</option>
                    {savedModelMissing && <option value={d.draft.model}>{d.draft.model} (saved; not in current catalog)</option>}
                    {models.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
            </Field>

            <Field id="reasoning" label="Reasoning effort"
                hint={supportsReasoning ? 'How much the model thinks before answering. Higher is slower and costs more.' : `${entry?.name || 'This platform'} doesn't support reasoning effort.`}>
                <div className="segment settings-segment" role="radiogroup" aria-label="Reasoning effort" id="reasoning-input">
                    {REASONING.map((option) => (
                        <button key={option.value || 'default'} type="button" role="radio"
                            aria-checked={d.draft.reasoningEffort === option.value}
                            className={`segment-btn${d.draft.reasoningEffort === option.value ? ' active' : ''}`}
                            disabled={!supportsReasoning && option.value !== ''}
                            onClick={() => setManual({ reasoningEffort: option.value })}>{option.label}</button>
                    ))}
                </div>
            </Field>

            <SaveBar section="chat" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
