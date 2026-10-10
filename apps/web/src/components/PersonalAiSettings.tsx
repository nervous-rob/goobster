import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { PersonalAiCatalog, PersonalAiFunction, PersonalAiSettings as Settings } from '../lib/types';
import { Field } from '../rooms/settings/SectionFrame';

const functions: Array<[PersonalAiFunction, string]> = [
    ['chat', 'Chat'], ['voiceChat', 'Voice conversation'], ['image', 'Image generation'],
    ['speech', 'Read-aloud speech'], ['transcription', 'Microphone transcription'], ['parlor', 'Parlor'], ['research', 'Research']
];

export function PersonalAiSettings({ onDirty }: { onDirty: (dirty: boolean) => void }) {
    const [saved, setSaved] = useState<Settings | null>(null);
    const [draft, setDraft] = useState<Settings | null>(null);
    const [apiKey, setApiKey] = useState('');
    const [catalog, setCatalog] = useState<PersonalAiCatalog | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const dirty = Boolean(apiKey || (draft && JSON.stringify(draft) !== JSON.stringify(saved)));
    useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
    useEffect(() => {
        let cancelled = false;
        api.personalAiSettings().then(settings => {
            if (cancelled) return;
            setSaved(settings); setDraft(settings);
            if (settings.connected) api.personalAiModels().then(models => {
                if (!cancelled) setCatalog(models);
            }).catch((failure: Error) => { if (!cancelled) setError(failure.message); });
        }).catch((failure: Error) => { if (!cancelled) setError(failure.message); });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        if (!saved?.connected) return;
        let cancelled = false;
        const timer = window.setInterval(() => {
            api.personalAiModels().then(models => { if (!cancelled) setCatalog(models); })
                .catch((failure: Error) => { if (!cancelled) setError(failure.message); });
        }, 10 * 60 * 1000);
        return () => { cancelled = true; window.clearInterval(timer); };
    }, [saved?.connected, saved?.completionUrl]);

    const run = async (action: () => Promise<void>) => {
        setBusy(true); setError(null); setNotice(null);
        try { await action(); } catch (failure) { setError((failure as Error).message); }
        finally { setBusy(false); }
    };
    const save = () => run(async () => {
        if (!draft) return;
        const models = Object.fromEntries(functions.filter(([fn]) => draft.models[fn] !== saved?.models[fn]).map(([fn]) => [fn, draft.models[fn]]));
        const next = await api.savePersonalAi({ completionUrl: draft.completionUrl, enabled: draft.enabled,
            ...(apiKey ? { apiKey } : {}), ...(Object.keys(models).length ? { models } : {}) });
        setSaved(next); setDraft(next); setApiKey('');
        setCatalog(await api.personalAiModels());
        setNotice('Personal AI settings saved.');
    });

    // The same two-column field as the rest of Settings: the label, scope and
    // explanation on the left, the labelled controls stacked on the right.
    return (
        <Field id="personal-ai" label="Personal AI · OpenRouter" scope="Your account" error={error}
            hint="Use your own API key and choose a model for each function in your private chats and work. Usage is billed to your provider account. Empty choices use the host’s provider. Keys are encrypted and never displayed again.">
            {notice && <p className="hint" role="status">{notice}</p>}
            {!draft ? <p className="hint" role="status">Loading personal AI settings…</p> : (
                <div className="settings-stack personal-ai">
                    <div className="personal-ai-field">
                        <label htmlFor="personal-ai-input">Completion URL</label>
                        <input id="personal-ai-input" className="input" type="url" value={draft.completionUrl} disabled={busy}
                            onChange={event => setDraft({ ...draft, completionUrl: event.target.value })} />
                        <p className="hint">OpenRouter works by default. Other public HTTPS endpoints must be allowed by your host and offer a compatible /models endpoint. Re-enter your key when changing the URL.</p>
                    </div>
                    <div className="personal-ai-field">
                        <label htmlFor="personal-ai-key">Your API key</label>
                        <input id="personal-ai-key" className="input" type="password" autoComplete="new-password" value={apiKey} disabled={busy}
                            placeholder={draft.connected ? 'Connected · leave blank to keep your key' : 'Paste your OpenRouter key'}
                            onChange={event => setApiKey(event.target.value)} />
                    </div>
                    <label className="settings-check personal-ai-toggle">
                        <input type="checkbox" checked={draft.enabled} disabled={busy}
                            onChange={event => setDraft({ ...draft, enabled: event.target.checked })} />
                        Use personal AI for assigned functions
                    </label>
                    {draft.connected && <>
                        <div className="personal-ai-status">
                            <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async () => {
                                setCatalog(await api.personalAiModels(true));
                            })}>Refresh personal models</button>
                            {catalog?.checkedAt && <span className="hint">Last checked {new Date(catalog.checkedAt).toLocaleString()}</span>}
                        </div>
                        {catalog && ['unavailable', 'stale'].includes(catalog.status) && <p role="status" className="hint">Model listing unavailable. Saved model choices are preserved.</p>}
                        <div className="personal-ai-models">
                            {functions.map(([fn, label]) => {
                                const choices = catalog?.models.filter(model => model.functions.includes(fn)) || [];
                                const value = draft.models[fn] || '';
                                return (
                                    <div key={fn} className="personal-ai-field">
                                        <label htmlFor={`personal-ai-${fn}`}>{label} model</label>
                                        <select id={`personal-ai-${fn}`} className="select" value={value} disabled={busy}
                                            onChange={event => setDraft({ ...draft, models: { ...draft.models, [fn]: event.target.value || null } })}>
                                            <option value="">Use host default</option>
                                            {value && !choices.some(model => model.id === value) && <option value={value}>{value} (saved)</option>}
                                            {choices.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                                        </select>
                                        {['image', 'speech', 'transcription'].includes(fn) && !choices.length && <p className="hint">This endpoint does not advertise a compatible model for this function.</p>}
                                    </div>
                                );
                            })}
                        </div>
                    </>}
                    <div className="btn-row personal-ai-actions">
                        <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void save()}>{draft.connected ? 'Save personal AI' : 'Connect personal AI'}</button>
                        {dirty && <button type="button" className="btn secondary" disabled={busy} onClick={() => { setDraft(saved); setApiKey(''); }}>Discard changes</button>}
                        {draft.connected && <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async () => {
                            const next = await api.disconnectPersonalAi();
                            setSaved(next); setDraft(next); setApiKey(''); setCatalog(null); setNotice('Personal AI disconnected.');
                        })}>Disconnect personal AI</button>}
                    </div>
                </div>
            )}
        </Field>
    );
}
