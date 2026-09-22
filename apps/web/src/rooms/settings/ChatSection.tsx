import { useCallback } from 'react';
import { ModelPicker, useModelCatalog, findModel } from '../../components/ModelPicker';
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
    const thoughtfulAvailable = section.thoughtfulAvailable !== false && Boolean(entry?.thoughtfulModel || hostDefault?.thoughtfulModel);

    const chatCatalog = useModelCatalog(entry?.key, 'chat');
    const parlorEntry = providers.find(p => p.key === (d.draft.parlorProvider || hostDefault?.key));
    const researchEntry = providers.find(p => p.key === (d.draft.researchProvider || hostDefault?.key));
    const parlorCatalog = useModelCatalog(parlorEntry?.key, 'parlor');
    const researchCatalog = useModelCatalog(researchEntry?.key, 'research');
    const selectedModel = findModel(chatCatalog.catalog, d.draft.model || entry?.chatModel || '');
    const reasoningLevels = selectedModel?.reasoning.levels || [];
    const mappedEffort = selectedModel?.reasoning.aliases[d.draft.reasoningEffort] || d.draft.reasoningEffort;
    const invalidSavedEffort = Boolean(mappedEffort && reasoningLevels.length && !reasoningLevels.includes(mappedEffort));
    const effectiveEffort = reasoningLevels.length && mappedEffort ? mappedEffort : selectedModel?.reasoning.default;
    const samplingAllowed = selectedModel?.sampling.mode === 'always'
        || (selectedModel?.sampling.mode === 'reasoning-off' && effectiveEffort === 'none');
    const savedEffortMissing = d.draft.reasoningEffort && !reasoningLevels.includes(d.draft.reasoningEffort);

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
                    onChange={(e) => d.set({ provider: e.target.value, model: '', reasoningEffort: '', thoughtful: false })}>
                    <option value="">Host default ({hostDefault?.name || 'auto'})</option>
                    {providers.map((p) => (
                        <option key={p.key} value={p.key} disabled={!p.configured}>
                            {p.configured ? p.name : `${p.name} — not configured here`}
                        </option>
                    ))}
                </select>
            </Field>

            <Field id="model" label="Model" hint="Models with a supported Goobster profile for this platform.">
                <ModelPicker id="model-input" label="Model" value={d.draft.model} defaultModel={entry?.chatModel}
                    state={chatCatalog} onChange={model => setManual({ model, reasoningEffort: '' })} />
            </Field>

            <Field id="reasoning" label="Reasoning effort"
                hint={reasoningLevels.length ? 'Higher effort allows more reasoning. It can take longer and use more tokens.' : 'This model uses provider defaults; no reasoning control is available.'}>
                <div className="segment settings-segment" role="radiogroup" aria-label="Reasoning effort" id="reasoning-input">
                    {['', ...reasoningLevels, ...(savedEffortMissing ? [d.draft.reasoningEffort] : [])].map(value => (
                        <button key={value || 'default'} type="button" role="radio"
                            aria-checked={d.draft.reasoningEffort === value}
                            className={`segment-btn${d.draft.reasoningEffort === value ? ' active' : ''}`}
                            disabled={Boolean(value && !reasoningLevels.includes(value))}
                            onClick={() => setManual({ reasoningEffort: value })}>
                            {value ? `${value[0].toUpperCase()}${value.slice(1)}` : 'Default'}
                        </button>
                    ))}
                </div>
                {selectedModel && <p className="hint">{invalidSavedEffort
                    ? 'The saved reasoning level is unsupported. Choose Default or a supported level.'
                    : <>Effective reasoning: {effectiveEffort || 'provider default'}{savedEffortMissing ? ' (saved preference adapted for this model)' : ''}.</>}</p>}
            </Field>

            <Field id="reply-tokens" label="Reply length budget" scope="Private chats & DMs"
                hint="Advanced visible-answer budget (256–8192 tokens). Hidden reasoning is added separately. Blank uses the host default.">
                <input id="reply-tokens-input" className="input" type="number" min={256} max={8192} step={1}
                    value={d.draft.replyMaxTokens} placeholder="Host default"
                    onChange={(e) => d.set({ replyMaxTokens: e.target.value })} />
            </Field>

            <Field id="sampling" label="Sampling" scope="Private chats & DMs"
                hint={samplingAllowed
                    ? (selectedModel?.sampling.exclusive ? 'Use temperature or top-p. When both are saved, temperature takes precedence.' : 'Adjust response variation with temperature and top-p.')
                    : 'Sampling controls are inactive for this model and reasoning setting. Saved values are retained for models that support them.'}>
                <div className="settings-row" id="sampling-input">
                    <input className="input" type="number" min={0} max={selectedModel?.sampling.temperatureMax ?? 2} step={0.1} aria-label="Temperature" disabled={!samplingAllowed}
                        value={d.draft.temperature} placeholder="Temperature"
                        onChange={(e) => d.set({ temperature: e.target.value })} />
                    <input className="input" type="number" min={0} max={1} step={0.05} aria-label="Top-p" disabled={!samplingAllowed}
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
                    <ModelPicker id="parlor-model-select" label="Parlor model" value={d.draft.parlorModel}
                        defaultModel={parlorEntry?.chatModel} state={parlorCatalog} onChange={parlorModel => d.set({ parlorModel })} />
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
                    <ModelPicker id="research-model-select" label="Research model" value={d.draft.researchModel}
                        defaultModel={researchEntry?.chatModel} state={researchCatalog} onChange={researchModel => d.set({ researchModel })} />
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
