import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api';
import type { ModelCatalog, ModelDescriptor, ModelGuess } from '../lib/types';

/** How often, and how long, to re-read a listing while Goobster is still writing descriptions. */
const GUESS_POLL_MS = 3000;
const GUESS_POLL_LIMIT = 10;

export function useModelCatalog(provider: string | undefined, workflow: 'chat' | 'parlor' | 'research') {
    const [state, setState] = useState<{ key: string; catalog: ModelCatalog | null; error: string | null } | null>(null);
    const [refreshVersion, setRefreshVersion] = useState(0);
    const [refreshing, setRefreshing] = useState(false);
    const key = `${provider || ''}:${workflow}`;
    useEffect(() => {
        let cancelled = false;
        let pending = false;
        let polls = 0;
        let pollTimer: number | undefined;
        const load = async (refresh = false) => {
            if (pending) return;
            pending = true;
            setRefreshing(true);
            try {
                const catalog = await api.modelCatalog(provider, workflow, refresh);
                if (cancelled) return;
                setState({ key, catalog, error: null });
                // Descriptions arrive a few seconds after a listing; the
                // cached re-read is cheap and stops once nothing is pending.
                if ((catalog.pendingGuesses || 0) > 0 && polls < GUESS_POLL_LIMIT) {
                    polls++;
                    pollTimer = window.setTimeout(() => { void load(); }, GUESS_POLL_MS);
                } else {
                    polls = 0;
                }
            } catch (error) {
                if (!cancelled) setState(prior => ({ key, catalog: prior?.key === key ? prior.catalog : null, error: (error as Error).message }));
            } finally {
                pending = false;
                if (!cancelled) setRefreshing(false);
            }
        };
        void load(refreshVersion > 0);
        const timer = window.setInterval(() => { void load(); }, 10 * 60 * 1000);
        return () => { cancelled = true; window.clearInterval(timer); window.clearTimeout(pollTimer); };
    }, [key, provider, workflow, refreshVersion]);
    // Never display another provider's entries while this one loads.
    return { ...(state?.key === key ? { ...state, loading: false } : { catalog: null, error: null, loading: true }),
        refreshing, refresh: () => setRefreshVersion(version => version + 1) };
}

export function findModel(catalog: ModelCatalog | null, id: string) {
    return catalog?.models.find(model => model.id === id || model.aliases.includes(id));
}

/** Database timestamps are UTC text (`YYYY-MM-DD HH:MM:SS`); Postgres may already hand back ISO. */
function writtenOn(text: string) {
    const iso = /Z$|[+-]\d\d:\d\d$/.test(text) ? text : `${text.replace(' ', 'T')}Z`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString();
}

const CONTROL_WORDS: Record<string, string> = {
    contextWindow: 'context window', maxOutputTokens: 'output limit', imageInput: 'image input',
    nativeSearch: 'web search', reasoning: 'reasoning levels', sampling: 'sampling', thinking: 'thinking', maxTemperature: 'temperature ceiling'
};
const words = (keys: string[] | undefined, skip: string[] = []) =>
    (keys || []).filter(key => CONTROL_WORDS[key] && !skip.includes(key)).map(key => CONTROL_WORDS[key]).join(', ');

function guessNote(guess: ModelGuess) {
    const family = guess.basisName ? `the rest follows ${guess.basisName}'s profile` : 'the rest is provider defaults because the name matches no known family';
    const listed = words(guess.listing, ['displayName', 'description']);
    const read = words(guess.controls);
    const evidence = [listed && `the provider's listing gives ${listed}`, read && `Goobster read ${read} from the provider's documentation`].filter(Boolean).join('; ');
    if (guess.source === 'ai') {
        const written = guess.writtenAt ? writtenOn(guess.writtenAt) : null;
        const from = guess.evidence === 'docs' ? 'from the provider\'s documentation' : 'from the name alone';
        return `Goobster's best guess ${from}${written ? `, written ${written}` : ''}. ${evidence ? `${evidence[0].toUpperCase()}${evidence.slice(1)}; ${family}` : `${family[0].toUpperCase()}${family.slice(1)}`}. Nothing here is a reviewed profile.`;
    }
    if (evidence) return `${evidence[0].toUpperCase()}${evidence.slice(1)}; ${family} as a best guess from the name.`;
    return `Best guess from the model name: ${family.replace(/^the rest /, '')}; limits stay unverified until reviewed.`;
}

function ModelDetails({ model, pending }: { model: ModelDescriptor; pending: boolean }) {
    const id = useId();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [dismissed, setDismissed] = useState(false);
    const open = !dismissed && (hovered || focused || pinned);
    const guess = model.status === 'discovered' ? model.guess || null : null;
    return (
        <div className="model-info" onMouseEnter={() => { setHovered(true); setDismissed(false); }}
            onMouseLeave={() => setHovered(false)} onFocus={() => { setFocused(true); setDismissed(false); }}
            onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setFocused(false); setPinned(false); } }}
            onKeyDown={event => { if (event.key === 'Escape') { setDismissed(true); setPinned(false); } }}>
            <button type="button" className="btn secondary small" aria-expanded={open} aria-controls={id}
                onClick={() => { setPinned(!pinned); setDismissed(pinned); }}>About this model</button>
            {open && <div id={id} className="model-info-panel" role="region" aria-label={`${model.displayName} details`}>
                <strong>{model.displayName}</strong>
                {model.status === 'discovered' && <span className="model-guess-badge">{guess?.source === 'ai' ? "Goobster's guess" : 'Best guess'}</span>}
                <p>{model.description}</p>
                {pending && guess?.source !== 'ai' && <p className="hint" role="status">Goobster is writing a short description of this model…</p>}
                <dl>
                    {guess?.bestFor && <><dt>Probably good for</dt><dd>{guess.bestFor}</dd></>}
                    {guess?.caveat && <><dt>Uncertain</dt><dd>{guess.caveat}</dd></>}
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
                {model.status === 'discovered' && <p className="hint">{guess ? guessNote(guess) : 'Uses provider defaults. Advanced capabilities and limits are unverified.'}</p>}
                {(model.sources[0] || guess?.sourceUrl) && <a href={model.sources[0] || guess?.sourceUrl || ''} target="_blank" rel="noreferrer">Provider documentation</a>}
            </div>}
        </div>
    );
}

export function ModelPicker({ id, label, value, defaultModel, onChange, state }: {
    id: string; label: string; value: string; defaultModel?: string | null;
    onChange: (id: string) => void; state: ReturnType<typeof useModelCatalog>;
}) {
    const { catalog, error, loading, refreshing, refresh } = state;
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
                        {model.displayName}{model.status === 'preview' ? ' · Preview' : model.status === 'custom' ? ' · Custom' : model.status === 'discovered' ? ' · API model' : ''}
                        {!model.selectable ? ' · Not listed' : ''}
                    </option>
                ))}
            </select>
            <div className="model-picker-actions">
                <button type="button" className="btn secondary small" aria-label={`Refresh ${label.toLowerCase()} list`}
                    disabled={loading || refreshing} onClick={refresh}>{refreshing ? 'Refreshing…' : 'Refresh models'}</button>
                {catalog?.discovery.checkedAt && <span className="hint">Last checked {new Date(catalog.discovery.checkedAt).toLocaleString()}</span>}
                {loading && <span className="hint" role="status">Loading model catalog…</span>}
            </div>
            {(error || unavailable) && <p className="hint" role="status">Live model listing unavailable. Saved choices are preserved; availability is unverified.</p>}
            {!loading && catalog && !selected && <p className="hint" role="status">This model has no supported profile. Choose a listed model or ask the host operator to add it.</p>}
            {selected && <div className="model-picker-summary">
                <span className="hint">{selected.description}</span>
                <ModelDetails key={selected.id} model={selected} pending={(catalog?.pendingGuesses || 0) > 0} />
            </div>}
        </div>
    );
}
