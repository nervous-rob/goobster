import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../../lib/api';
import type { ResetPreviewResponse, SettingsSectionId } from '../../lib/types';
import { Modal } from '../../components/Modal';
import { useToast } from '../../hooks/useToast';
import type { SectionDraft } from '../../hooks/useUserSettings';
import { SECTION_BY_ID, type ScopeLabel } from './sectionMeta';

export function ScopeBadge({ scope }: { scope: ScopeLabel }) {
    return <span className="badge settings-scope" title="Where this setting applies">{scope}</span>;
}

/**
 * One labelled control: plain-language label, optional effect statement, and
 * an anchor id so search results and deep links (`#preferred-name`) can land
 * on the control itself.
 */
export function Field({
    id,
    label,
    hint,
    error,
    children,
    inline = false
}: {
    id: string;
    label: ReactNode;
    hint?: ReactNode;
    error?: string | null;
    children: ReactNode;
    inline?: boolean;
}) {
    return (
        <div className={`settings-field${inline ? ' inline' : ''}`} id={id} data-field={id}>
            <div className="settings-field-head">
                <label htmlFor={`${id}-input`}>{label}</label>
                {hint && <div className="hint">{hint}</div>}
            </div>
            <div className="settings-field-control">
                {children}
                {error && <div className="settings-field-error" role="alert">{error}</div>}
            </div>
        </div>
    );
}

export function SectionHeader({
    id,
    scope,
    appliesTo,
    children
}: {
    id: SettingsSectionId;
    scope: ScopeLabel;
    appliesTo?: string[];
    children?: ReactNode;
}) {
    const meta = SECTION_BY_ID[id];
    return (
        <div className="settings-section-head">
            <div>
                <h2>{meta.icon} {meta.title}</h2>
                <p className="hint">{meta.blurb}</p>
                <div className="settings-applies">
                    <ScopeBadge scope={scope} />
                    {appliesTo && appliesTo.length > 0 && (
                        <span className="hint">Applies to: {appliesTo.map(humanizeSurface).join(', ')}</span>
                    )}
                </div>
            </div>
            {children}
        </div>
    );
}

const SURFACES: Record<string, string> = {
    'study': 'the Study',
    'discord-dm': 'Discord DMs',
    'study-voice': 'Study voice chat',
    'attention-inbox': 'the Noticed inbox',
    'proactive-actions': 'proactive actions',
    'study-memory': 'Study memories',
    'discord-dm-memory': 'DM memories',
    'web-portal': 'this portal',
    'account': 'your account'
};

function humanizeSurface(key: string): string {
    return SURFACES[key] || key;
}

/**
 * The explicit Save / Discard bar plus the reviewable Reset flow. A section
 * save cannot trigger anything destructive; retention and forget-me have
 * their own flows inside the Memory section.
 */
export function SaveBar<D>({
    section,
    draft,
    onSaved,
    resettable = true,
    describe
}: {
    section: SettingsSectionId;
    draft: SectionDraft<D>;
    onSaved?: () => void;
    resettable?: boolean;
    describe?: (key: string, value: unknown) => string;
}) {
    const toast = useToast();
    const [preview, setPreview] = useState<ResetPreviewResponse | null>(null);
    const [loadingPreview, setLoadingPreview] = useState(false);

    async function openReset() {
        setLoadingPreview(true);
        try {
            setPreview(await api.resetSettingsPreview(section));
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setLoadingPreview(false);
        }
    }

    async function confirmReset() {
        if (!preview) return;
        const result = await draft.reset(preview.currentRevision);
        setPreview(null);
        if (result) {
            toast(`${SECTION_BY_ID[section].title} reset to defaults.`);
            onSaved?.();
        }
    }

    async function save() {
        const result = await draft.save();
        if (result) {
            toast(`${SECTION_BY_ID[section].title} saved.`);
            onSaved?.();
        }
    }

    return (
        <>
            {draft.changedElsewhere && (
                <div className="settings-banner" role="status">
                    <span>Changed elsewhere — these settings were updated from another device or Discord while you were editing.</span>
                    <button type="button" className="btn small" onClick={draft.takeServer}>Load latest</button>
                </div>
            )}
            {draft.error && <div className="settings-field-error" role="alert">{draft.error}</div>}
            <div className={`settings-savebar${draft.dirty ? ' is-dirty' : ''}`}>
                <span className="hint settings-dirty-note" aria-live="polite">
                    {draft.saving ? 'Saving…' : draft.dirty ? 'Unsaved changes' : 'All changes saved'}
                </span>
                <div className="settings-savebar-actions">
                    {resettable && (
                        <button type="button" className="btn subtle" disabled={draft.saving || loadingPreview} onClick={openReset}>
                            {loadingPreview ? 'Checking…' : 'Reset to defaults…'}
                        </button>
                    )}
                    <button type="button" className="btn" disabled={!draft.dirty || draft.saving} onClick={draft.discard}>Discard</button>
                    <button type="button" className="btn primary" disabled={!draft.dirty || draft.saving} onClick={save}>Save changes</button>
                </div>
            </div>
            {preview && (
                <Modal onClose={() => setPreview(null)}>
                    <h2>Reset {SECTION_BY_ID[section].title.toLowerCase()}?</h2>
                    {Object.keys(preview.changes).length === 0 ? (
                        <p className="hint">Everything in this section is already at its default. Nothing would change.</p>
                    ) : (
                        <>
                            <p className="hint">These preferences go back to their defaults. Nothing else is touched — no content is deleted, no connections change.</p>
                            <ul className="settings-diff">
                                {Object.entries(preview.changes).map(([key, value]) => (
                                    <li key={key}>
                                        <code>{describe ? describe(key, value) : key}</code>
                                        <span className="hint"> {formatValue(preview.currentValues[key])} → {formatValue(value)}</span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    )}
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={() => setPreview(null)}>Cancel</button>
                        <button type="button" className="btn danger" disabled={draft.saving || Object.keys(preview.changes).length === 0} onClick={confirmReset}>
                            Reset
                        </button>
                    </div>
                </Modal>
            )}
        </>
    );
}

export function formatValue(value: unknown): string {
    if (value === null || value === undefined || value === '') return 'default';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (typeof value === 'object') {
        const entries = Object.keys(value as object);
        return entries.length === 0 ? 'none' : `${entries.length} set`;
    }
    const text = String(value);
    return text.length > 48 ? `${text.slice(0, 45)}…` : text;
}

/** Scroll a deep-linked control into view and give it focus once it exists. */
export function useFieldAnchor(hash: string | null) {
    useEffect(() => {
        if (!hash) return;
        const id = hash.replace(/^#/, '');
        if (!id) return;
        const timer = window.setTimeout(() => {
            const el = document.getElementById(id);
            if (!el) return;
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            el.classList.add('is-targeted');
            const input = el.querySelector<HTMLElement>('input, select, textarea, button');
            input?.focus({ preventScroll: true });
            window.setTimeout(() => el.classList.remove('is-targeted'), 2400);
        }, 60);
        return () => window.clearTimeout(timer);
    }, [hash]);
}
