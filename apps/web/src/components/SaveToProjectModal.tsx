import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';

export type SaveToProjectTarget = {
    source: string;
    language: string;
    title?: string;
    grants?: { observatoryRead: string[] };
    conversationId?: number | null;
    messageId?: number | null;
};

type ProjectOption = { slug: string; name: string };
type AssetOption = { slug: string; name: string; kind: string; currentVersion?: number | null };

/**
 * Shared picker for Study "Save to project…" and Workshop "Promote to project…".
 * `promote` stamps a pin's migratedAssetId; otherwise this is a plain asset save.
 */
export function SaveToProjectModal({
    target,
    onClose,
    onSaved,
    origin = 'chat',
    heading = 'Save to project…',
    hint = 'Store this mini-app as a versioned project asset. Later edits become v2 of the same app.',
    appletId = null,
    promote = false
}: {
    target: SaveToProjectTarget;
    onClose: () => void;
    onSaved?: () => void;
    origin?: 'chat' | 'portal';
    heading?: string;
    hint?: string;
    appletId?: number | null;
    promote?: boolean;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [project, setProject] = useState('');
    const [mode, setMode] = useState<'new' | 'existing'>('new');
    const [assetSlug, setAssetSlug] = useState('');
    const [name, setName] = useState(target.title || '');
    const [busy, setBusy] = useState(false);

    const projects = useQuery({
        queryKey: keys.observatory,
        queryFn: () => api.observatoryProjects() as Promise<{ projects: ProjectOption[] }>,
        retry: false
    });
    const assets = useQuery({
        queryKey: [...keys.projectAssets(project), 'app'],
        queryFn: () => api.projectAssets(project, 'app') as Promise<{ assets: AssetOption[] }>,
        enabled: Boolean(project),
        retry: false
    });

    const list = projects.data?.projects || [];
    const appAssets = (assets.data?.assets || []).filter((a) => a.kind === 'app');
    const canSubmit = Boolean(project) || promote;

    async function save() {
        const existing = mode === 'existing';
        const targetProject = project || 'workshop';
        if (!project && !promote) {
            toast('Pick a project first.', true);
            return;
        }
        if (existing && !assetSlug) {
            toast('Pick an existing app to version.', true);
            return;
        }
        if (!existing && !name.trim()) {
            toast('Give the new app a name.', true);
            return;
        }
        setBusy(true);
        try {
            const chosen = existing ? appAssets.find((a) => a.slug === assetSlug) : null;
            const body = {
                slug: existing ? assetSlug : undefined,
                name: existing ? (chosen?.name || name.trim()) : name.trim(),
                kind: 'app',
                language: target.language,
                source: target.source,
                origin,
                conversationId: target.conversationId,
                messageId: target.messageId,
                grants: target.grants
            };
            const saved = (promote
                ? await api.promoteApplet({
                    ...body,
                    appletId: appletId ?? undefined,
                    project: targetProject
                })
                : await api.saveProjectAsset(targetProject, body)
            ) as {
                name?: string;
                slug?: string;
                version?: number;
                deduped?: boolean;
                project?: string;
                asset?: {
                    name: string;
                    slug: string;
                    version: number;
                    deduped?: boolean;
                    project: string;
                };
            };
            const asset = saved.asset || saved;
            const assetName = asset.name || body.name;
            const version = asset.version;
            const projectSlug = asset.project || targetProject;
            toast(asset.deduped
                ? `"${assetName}" is already at v${version} — identical source.`
                : `${promote ? 'Promoted' : 'Saved'} "${assetName}" as v${version} in ${projectSlug}.`);
            await queryClient.invalidateQueries({ queryKey: keys.projectAssets(projectSlug) });
            await queryClient.invalidateQueries({ queryKey: keys.applets });
            onSaved?.();
            onClose();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal onClose={onClose}>
            <h2>{heading}</h2>
            <p className="hint">{hint}</p>
            {projects.isError && <div className="hint">{(projects.error as Error).message}</div>}
            {list.length === 0 && !projects.isPending && (
                <div className="hint">
                    {promote
                        ? 'No projects yet — promoting will create a Workshop inbox project.'
                        : 'No projects yet — create one in the Observatory first.'}
                </div>
            )}
            <div className="field">
                <label htmlFor="save-project">Project</label>
                <select
                    id="save-project"
                    className="select"
                    value={project}
                    onChange={(e) => { setProject(e.target.value); setAssetSlug(''); }}
                >
                    <option value="">{promote ? 'Workshop (inbox)' : 'Select a project…'}</option>
                    {list.map((item) => (
                        <option key={item.slug} value={item.slug}>{item.name} ({item.slug})</option>
                    ))}
                </select>
            </div>
            <div className="field">
                <label>Save as</label>
                <div className="segment" role="tablist">
                    <button type="button" className={`segment-btn${mode === 'new' ? ' active' : ''}`} onClick={() => setMode('new')}>New app</button>
                    <button
                        type="button"
                        className={`segment-btn${mode === 'existing' ? ' active' : ''}`}
                        onClick={() => setMode('existing')}
                        disabled={!project || appAssets.length === 0}
                    >New version of existing</button>
                </div>
            </div>
            {mode === 'new' ? (
                <div className="field">
                    <label htmlFor="save-asset-name">Name</label>
                    <input
                        id="save-asset-name"
                        className="input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Dashboard"
                    />
                </div>
            ) : (
                <div className="field">
                    <label htmlFor="save-existing">Existing app</label>
                    <select
                        id="save-existing"
                        className="select"
                        value={assetSlug}
                        onChange={(e) => setAssetSlug(e.target.value)}
                    >
                        <option value="">Select an app…</option>
                        {appAssets.map((item) => (
                            <option key={item.slug} value={item.slug}>
                                {item.name} ({item.slug}{item.currentVersion ? ` · v${item.currentVersion}` : ''})
                            </option>
                        ))}
                    </select>
                </div>
            )}
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={busy || !canSubmit} onClick={() => void save()}>
                    {busy ? 'Saving…' : (promote ? 'Promote' : 'Save')}
                </button>
            </div>
        </Modal>
    );
}
