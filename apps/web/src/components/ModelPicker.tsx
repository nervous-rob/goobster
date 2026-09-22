import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import type { ModelCatalog, ModelDescriptor } from '../lib/types';

export function useModelCatalog(provider: string | undefined, workflow: 'chat' | 'parlor' | 'research') {
    const [state, setState] = useState<{ key: string; catalog: ModelCatalog | null; error: string | null } | null>(null);
    const key = `${provider || ''}:${workflow}`;
    useEffect(() => {
        let cancelled = false;
        api.modelCatalog(provider, workflow).then(catalog => {
            if (!cancelled) setState({ key, catalog, error: null });
        }).catch((error: Error) => {
            if (!cancelled) setState({ key, catalog: null, error: error.message });
        });
        return () => { cancelled = true; };
    }, [key, provider, workflow]);
    // Never display another provider's entries while this one loads.
    return state?.key === key ? { ...state, loading: false } : { catalog: null, error: null, loading: true };
}

export function findModel(catalog: ModelCatalog | null, id: string) {
    return catalog?.models.find(model => model.id === id || model.aliases.includes(id));
}

function ModelDetails({ model }: { model: ModelDescriptor }) {
    const id = useId();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const open = !dismissed && (hovered || focused || pinned);
    return (
        <div className="model-info" onMouseEnter={() => { setHovered(true); setDismissed(false); }}
            onMouseLeave={() => setHovered(false)} onFocus={() => { setFocused(true); setDismissed(false); }}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setPinned(false); } }}
            onKeyDown={event => { if (event.key === 'Escape') { setDismissed(true); setPinned(false); } }}>
            <button type="button" className="btn secondary" aria-expanded={open} aria-controls={id}
                onClick={() => { setPinned(!pinned); setDismissed(pinned); }}>About this model</button>
            {open && <div id={id} className="model-info-panel" role="region" aria-label={`${model.displayName} details`}>
                <strong>{model.displayName}</strong>
                <p>{model.description}</p>
                <dl>
                    <dt>Input</dt><dd>{model.input.join(', ')}</dd>
                    <dt>Tools</dt><dd>{model.capabilities.tools || 'Unavailable'}</dd>
                    <dt>Built-in web search</dt><dd>{model.capabilities.nativeSearch ? 'Supported' : 'Unavailable'}</dd>
                    <dt>Reasoning</dt><dd>{model.reasoning.levels.join(', ') || 'Provider default'}</dd>
                    {model.contextWindow && <><dt>Context window</dt><dd>{model.contextWindow.toLocaleString()} tokens</dd></>}
                    {model.maxOutputTokens && <><dt>Output limit</dt><dd>{model.maxOutputTokens.toLocaleString()} tokens, including reasoning</dd></>}
                    <dt>Availability</dt><dd>{model.availability === 'listed' ? 'Listed by your provider' : model.availability === 'not-listed' ? 'Not in the latest provider listing' : 'Not currently verified'}</dd>
                </dl>
                {model.capabilities.nativeSearchExcludedEfforts?.length && <p className="hint">Built-in search is unavailable at {model.capabilities.nativeSearchExcludedEfforts.join(', ')} reasoning.</p>}
                {model.checkedAt && <p className="hint">Compatibility reviewed {model.checkedAt}. Provider access and quotas can vary.</p>}
                {model.status === 'custom' && <p className="hint">Compatibility profile supplied by the host operator.</p>}
                {model.sources[0] && <a href={model.sources[0]} target="_blank" rel="noreferrer">Provider documentation</a>}
            </div>}
        </div>
    );
}

export function ModelPicker({ id, label, value, defaultModel, onChange, state }: {
    id: string; label: string; value: string; defaultModel?: string | null;
    onChange: (id: string) => void; state: ReturnType<typeof useModelCatalog>;
}) {
    const { catalog, error, loading } = state;
    const selected = findModel(catalog, value || defaultModel || '');
    const savedOnly = Boolean(value && !catalog?.models.some(model => model.id === value));
    const unavailable = catalog && ['stale', 'unavailable'].includes(catalog.discovery.status);
    return (
        <div className="model-picker">
            <select id={id} aria-label={label} className="select" value={value} disabled={loading}
                onChange={event => onChange(event.target.value)}>
                <option value="">Provider default{defaultModel ? ` (${defaultModel})` : ''}</option>
                {savedOnly && <option value={value}>{value} (saved)</option>}
                {(catalog?.models || []).filter(model => model.selectable || model.id === value).map(model => (
                    <option key={model.id} value={model.id} disabled={!model.selectable}>
                        {model.displayName}{model.status === 'preview' ? ' · Preview' : model.status === 'custom' ? ' · Custom' : ''}
                        {!model.selectable ? ' · Not listed' : ''}
                    </option>
                ))}
            </select>
            {loading && <span className="hint" role="status">Loading model catalog…</span>}
            {(error || unavailable) && <p className="hint" role="status">Live model listing unavailable. Saved choices are preserved; availability is unverified.</p>}
            {!loading && catalog && !selected && <p className="hint" role="status">This model has no supported profile. Choose a listed model or ask the host operator to add it.</p>}
            {selected && <div className="model-picker-summary">
                <span className="hint">{selected.description}</span>
                <ModelDetails key={selected.id} model={selected} />
            </div>}
        </div>
    );
}
