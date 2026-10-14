import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useToast } from '../../hooks/useToast';
import { ciBadge, type CiPayload } from '../../components/repoParts';

export type StepCodeLink = { repo: string | null; branch: string; requireGreenCi: boolean };

export type StepCodeState = {
    stepId: number;
    name?: string;
    repo?: string;
    branch: string;
    local?: boolean;
    current?: boolean;
    onGitHub?: boolean | null;
    url?: string;
    ci?: CiPayload | null;
    pr?: { number: number; title: string; url: string; draft: boolean } | null;
    remoteError?: string | null;
    error?: string;
};

/** The code state of a mission's linked steps (one read per mission). */
export function useStepCode(slug: string, ownerId: string | null | undefined, missionId: number, enabled: boolean) {
    return useQuery({
        queryKey: [...keys.projectMission(slug, ownerId), 'code', missionId],
        queryFn: () => api.projectMissionCode(slug, missionId, ownerId) as Promise<{ steps: StepCodeState[] }>,
        enabled,
        retry: false,
        refetchInterval: (query) => ((query.state.data as { steps: StepCodeState[] } | undefined)?.steps
            .some((step) => step.ci?.state === 'pending') ? 30_000 : false)
    });
}

/**
 * A plan step's link to code: a clone and branch, shown with the branch's
 * pull request and CI, and whether the step waits for green CI. Editable
 * while the plan is open.
 */
export function StepCode({ slug, ownerId, missionId, stepId, link, state, editable }: {
    slug: string;
    ownerId?: string | null;
    missionId: number;
    stepId: number;
    link: StepCodeLink | null | undefined;
    state: StepCodeState | undefined;
    editable: boolean;
}) {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [editing, setEditing] = useState(false);
    const [repo, setRepo] = useState(link?.repo || '');
    const [branch, setBranch] = useState(link?.branch || '');
    const [requireGreenCi, setRequireGreenCi] = useState(Boolean(link?.requireGreenCi));
    const repos = useQuery({
        queryKey: keys.projectRepos(slug, ownerId),
        queryFn: () => api.projectRepos(slug, ownerId) as Promise<{ enabled: boolean; repos: { name: string; repo: string }[] }>,
        enabled: editing,
        retry: false
    });

    async function save(clear = false) {
        try {
            await api.linkProjectMissionStepCode(slug, stepId, {
                missionId, repoName: clear ? null : (repo || null), branch: clear ? null : branch.trim(), requireGreenCi: clear ? false : requireGreenCi
            }, ownerId);
            setEditing(false);
            await queryClient.invalidateQueries({ queryKey: keys.projectMission(slug, ownerId) });
            toast(clear ? 'Code link removed.' : `Step linked to ${branch.trim()}.`);
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    if (editing) {
        const options = repos.data?.repos || [];
        return (
            <div className="obs-step-code-form" data-testid={`step-code-form-${stepId}`}>
                <select className="input" value={repo} onChange={(e) => setRepo(e.target.value)} aria-label="Repository">
                    <option value="">{options.length === 1 ? options[0].repo : 'Repository…'}</option>
                    {options.map((entry) => <option key={entry.name} value={entry.name}>{entry.repo} (repos/{entry.name})</option>)}
                </select>
                <input className="input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch" aria-label="Branch" />
                <label className="hint"><input type="checkbox" checked={requireGreenCi} onChange={(e) => setRequireGreenCi(e.target.checked)} /> Done needs green CI</label>
                <button type="button" className="btn small" disabled={!branch.trim()} onClick={() => void save(false)}>Save</button>
                {link && <button type="button" className="btn small subtle" onClick={() => void save(true)}>Remove link</button>}
                <button type="button" className="btn small subtle" onClick={() => setEditing(false)}>Cancel</button>
                {repos.data && !repos.data.enabled && <span className="hint">Repositories are off on this server.</span>}
                {repos.data?.enabled && options.length === 0 && <span className="hint">Clone a repository in the Code view first.</span>}
            </div>
        );
    }
    if (!link) {
        return editable
            ? <button type="button" className="btn small subtle obs-step-code-add" onClick={() => setEditing(true)}>🔗 Link code</button>
            : null;
    }
    return (
        <div className="obs-step-code" data-testid={`step-code-${stepId}`}>
            🔗 {state?.url
                ? <a href={state.url} target="_blank" rel="noreferrer"><code>{link.branch}</code></a>
                : <code>{link.branch}</code>}
            {state?.repo ? <span className="hint"> ({state.repo})</span> : null}
            {state?.error ? <span className="hint"> · {state.error}</span> : null}
            {state && !state.error && state.onGitHub === false ? <span className="hint"> · not on GitHub yet</span> : null}
            {state?.pr ? <> · <a href={state.pr.url} target="_blank" rel="noreferrer">PR #{state.pr.number}{state.pr.draft ? ' (draft)' : ''}</a></> : null}
            {state?.ci && state.onGitHub !== false ? <> · {ciBadge(state.ci)}</> : null}
            {state?.remoteError ? <span className="hint"> · GitHub: {state.remoteError}</span> : null}
            {link.requireGreenCi ? <span className="badge">needs green CI</span> : null}
            {editable && <button type="button" className="btn small subtle" onClick={() => setEditing(true)}>Edit</button>}
        </div>
    );
}
