import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['chat']['values'];
type Provider = { key: string; name: string; configured: boolean; isDefault?: boolean; chatModel?: string | null; thoughtfulModel?: string | null; reasoningEffort?: boolean };
type Draft = {
    provider: string;
    model: string;
    reasoningEffort: string;
    thoughtful: boolean;
    replyMaxTokens: string;
    temperature: string;
    topP: string;
    parlorProvider: string;
    parlorModel: string;
    researchProvider: string;
    researchModel: string;
    disabledTools: string[];
    usageAlertTokens: string;
};

const OPTIONAL_TOOLS: Array<{ name: string; label: string }> = [
    { name: 'performSearch', label: 'Web search' },
    { name: 'generateImage', label: 'Image generation' },
    { name: 'runCode', label: 'Code runner' },
    { name: 'observatory', label: 'Observatory' },
    { name: 'requestPythonPackages', label: 'Python packages' },
    { name: 'findImages', label: 'Find images on the web' },
    { name: 'fetchWebFile', label: 'Fetch files from the web' },
    { name: 'playTrack', label: 'Play a track' },
    { name: 'speakMessage', label: 'Speak a message' },
    { name: 'launchCursorAgent', label: 'Cursor agent' },
    { name: 'createGithubIssue', label: 'Create GitHub issue' },
    { name: 'executePlan', label: 'Execute a plan' },
    { name: 'searchGithubCode', label: 'Search GitHub code' },
    { name: 'readGithubFile', label: 'Read GitHub file' },
    { name: 'searchNotion', label: 'Search Notion' },
    { name: 'readNotionPage', label: 'Read Notion page' }
];

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
    thoughtful: Boolean(v.thoughtful),
    replyMaxTokens: v.replyMaxTokens != null ? String(v.replyMaxTokens) : '',
    temperature: v.temperature != null ? String(v.temperature) : '',
    topP: v.topP != null ? String(v.topP) : '',
    parlorProvider: v.parlorProvider || '',
    parlorModel: v.parlorModel || '',
    researchProvider: v.researchProvider || '',
    researchModel: v.researchModel || '',
    disabledTools: Array.isArray(v.disabledTools) ? [...v.disabledTools] : [],
    usageAlertTokens: v.usageAlertTokens != null ? String(v.usageAlertTokens) : ''
});

const LABELS: Record<string, string> = {
    provider: 'Model platform',
    model: 'Model',
    reasoningEffort: 'Reasoning effort',
    replyMaxTokens: 'Reply length budget',
    temperature: 'Temperature',
    topP: 'Top-p',
    parlorProvider: 'Parlor platform',
    parlorModel: 'Parlor model',
    researchProvider: 'Research platform',
    researchModel: 'Research model',
    disabledTools: 'Optional tools',
    usageAlertTokens: 'Usage alert'
};

function emptyToNull(value: string): string | null {
    const clean = value.trim();
    return clean ? clean : null;
}

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
        for (const key of ['provider', 'model', 'reasoningEffort', 'parlorProvider', 'parlorModel', 'researchProvider', 'researchModel']) {
            if (key in diff) diff[key] = emptyToNull(String(diff[key] ?? ''));
        }
        for (const key of ['replyMaxTokens', 'usageAlertTokens']) {
            if (key in diff) {
                const raw = String(draft[key as 'replyMaxTokens' | 'usageAlertTokens']).trim();
                diff[key] = raw ? Number(raw) : null;
            }
        }
        for (const key of ['temperature', 'topP'] as const) {
            if (key in diff) {
                const raw = String(draft[key]).trim();
                diff[key] = raw ? Number(raw) : null;
            }
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

            <Field id="reply-tokens" label="Reply length budget" scope="Private chats & DMs"
                hint="Advanced visible-answer budget (256–8192 tokens). Hidden reasoning is added separately. Blank uses the host default.">
                <input id="reply-tokens-input" className="input" type="number" min={256} max={8192} step={1}
                    value={d.draft.replyMaxTokens} placeholder="Host default"
                    onChange={(e) => d.set({ replyMaxTokens: e.target.value })} />
            </Field>

            <Field id="sampling" label="Sampling" scope="Private chats & DMs"
                hint="Temperature (0–2) and top-p (0–1). Providers that reject sampling drop these instead of failing the turn.">
                <div className="settings-row" id="sampling-input">
                    <input className="input" type="number" min={0} max={2} step={0.1} aria-label="Temperature"
                        value={d.draft.temperature} placeholder="Temperature"
                        onChange={(e) => d.set({ temperature: e.target.value })} />
                    <input className="input" type="number" min={0} max={1} step={0.05} aria-label="Top-p"
                        value={d.draft.topP} placeholder="Top-p"
                        onChange={(e) => d.set({ topP: e.target.value })} />
                </div>
            </Field>

            <Field id="parlor-model" label="Parlor model default" scope="Your account"
                hint="Used for owned Parlor generation only. Shared personas and existing conversations keep their own configuration.">
                <div className="settings-row" id="parlor-model-input">
                    <select className="select" aria-label="Parlor platform" value={d.draft.parlorProvider}
                        onChange={(e) => d.set({ parlorProvider: e.target.value, parlorModel: '' })}>
                        <option value="">Host default</option>
                        {providers.map((p) => (
                            <option key={p.key} value={p.key} disabled={!p.configured}>
                                {p.configured ? p.name : `${p.name} — not configured here`}
                            </option>
                        ))}
                    </select>
                    <input className="input" aria-label="Parlor model id" value={d.draft.parlorModel}
                        placeholder="Provider default model"
                        onChange={(e) => d.set({ parlorModel: e.target.value })} />
                </div>
            </Field>

            <Field id="research-model" label="Research model default" scope="Your account"
                hint="Snapshotted into newly created personal research jobs. Existing expeditions keep the model they started with.">
                <div className="settings-row" id="research-model-input">
                    <select className="select" aria-label="Research platform" value={d.draft.researchProvider}
                        onChange={(e) => d.set({ researchProvider: e.target.value, researchModel: '' })}>
                        <option value="">Host default</option>
                        {providers.map((p) => (
                            <option key={p.key} value={p.key} disabled={!p.configured}>
                                {p.configured ? p.name : `${p.name} — not configured here`}
                            </option>
                        ))}
                    </select>
                    <input className="input" aria-label="Research model id" value={d.draft.researchModel}
                        placeholder="Provider default model"
                        onChange={(e) => d.set({ researchModel: e.target.value })} />
                </div>
            </Field>

            <Field id="disabled-tools" label="Optional tools" scope="Your account"
                hint="Uncheck to prefer skipping that tool in personal work. This cannot grant credentials, skip approval, or override host restrictions.">
                <div className="settings-tool-list" id="disabled-tools-input">
                    {OPTIONAL_TOOLS.map((tool) => {
                        const on = !d.draft.disabledTools.includes(tool.name);
                        return (
                            <label key={tool.name} className="settings-check">
                                <input type="checkbox" checked={on}
                                    onChange={() => d.set({
                                        disabledTools: on
                                            ? [...d.draft.disabledTools, tool.name]
                                            : d.draft.disabledTools.filter((name) => name !== tool.name)
                                    })} />
                                {tool.label}
                            </label>
                        );
                    })}
                </div>
            </Field>

            <Field id="usage-alert" label="Usage alert" scope="Your account"
                hint="Informational threshold on the Usage page. This is not a hard spend cap.">
                <input id="usage-alert-input" className="input" type="number" min={1000} step={1000}
                    value={d.draft.usageAlertTokens} placeholder="No alert"
                    onChange={(e) => d.set({ usageAlertTokens: e.target.value })} />
            </Field>

            <Field id="byok" label="Personal AI keys" scope="Your account"
                hint="Bring-your-own provider keys are not stored in Settings. This host uses the operator-configured keys, and missing keys disable that platform above instead of erroring. GitHub and Notion connectors live under Connections.">
                <p className="hint" id="byok-input">Host keys only — personal BYOK is not available on this host.</p>
            </Field>

            <SaveBar section="chat" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
