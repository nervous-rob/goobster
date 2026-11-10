import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import type { ResponsibilityOperation } from '../../lib/types';
import type { Project } from './grants';

/**
 * The wider ways a responsibility may notice work by itself (DA-8,
 * documentation/delegated_opportunity_sources.md): requests made in the
 * person's own chats, new causes of a failed run, CI results on watched
 * branches, and items they kept from a source they follow. A pilot
 * capability: offered only to a person who has it.
 */

export type WiderSources = { personalChat: boolean; jobFailures: boolean; ciRepos: string[]; followed: number[] };
export const NO_WIDER_SOURCES: WiderSources = { personalChat: false, jobFailures: false, ciRepos: [], followed: [] };

/** The `scopes.sources` names these choices add. */
export function widerScopes(value: WiderSources, project: Project | undefined): string[] {
    const list: string[] = [];
    if (value.personalChat) list.push('personal_chat');
    if (project && value.jobFailures) list.push('job_failure');
    if (project && value.ciRepos.length) list.push('ci_verdict');
    if (project && value.followed.length) list.push('followed_source');
    return list;
}

/** The read grants those choices need (a source is read only as far as a grant covers it). */
export function widerOperations(value: WiderSources, project: Project | undefined): ResponsibilityOperation[] {
    if (!project) return [];
    return [
        ...value.ciRepos.map((repo): ResponsibilityOperation => ({
            operation: 'read', resource: { kind: 'repository', ids: [repo], projectId: String(project.id) }
        })),
        ...value.followed.map((id): ResponsibilityOperation => ({
            operation: 'read', resource: { kind: 'process', ids: [`followed_source:${id}`] }
        }))
    ];
}

function toggle<T>(list: T[], item: T, on: boolean): T[] {
    return on ? [...list.filter((entry) => entry !== item), item] : list.filter((entry) => entry !== item);
}

export function SourceChoices({ project, value, onChange }: { project: Project | undefined; value: WiderSources; onChange: (next: WiderSources) => void }) {
    const me = useMe();
    const access = useQuery({ queryKey: keys.assistantAccess, queryFn: () => api.assistantAccess() });
    const repos = useQuery({
        queryKey: keys.projectRepos(project?.slug || '', project?.ownerId),
        queryFn: () => api.projectRepos(project!.slug, project!.ownerId) as Promise<{ enabled: boolean; repos: Array<{ name: string; repo: string }> }>,
        enabled: Boolean(project)
    });
    const followed = useQuery({
        queryKey: ['assistant-followed-sources', project?.id],
        queryFn: () => api.followedSources({ projectId: project!.id }),
        enabled: Boolean(project)
    });
    if (!access.data?.capabilities.sources) return null;
    const name = me.assistant.name;
    return (
        <fieldset className="field" data-testid="responsibility-wider-sources">
            <legend>Notice work by itself (pilot)</legend>
            <div className="hint">
                Only what happens after you activate this counts. Anything already there is history and is never acted on.
                At most 3 pieces of work a day are proposed from each of these, and each runs only within what you allowed above.
            </div>
            <label>
                <input type="checkbox" checked={value.personalChat} data-testid="responsibility-chat-requests"
                    onChange={(e) => onChange({ ...value, personalChat: e.target.checked })} />{' '}
                Take requests you make in your own chats, even without calling {name} by name
            </label>
            {value.personalChat && (
                <div className="hint">
                    Only messages you wrote. A passing mention proposes nothing. Chats that are incognito, excluded from memory, or
                    written while &quot;learn from my chats&quot; is off are never read.
                </div>
            )}
            {project && (
                <>
                    <label>
                        <input type="checkbox" checked={value.jobFailures} data-testid="responsibility-job-failures"
                            onChange={(e) => onChange({ ...value, jobFailures: e.target.checked })} />{' '}
                        Look into a run of yours in {project.name} that fails for a new reason (once per cause, not per retry)
                    </label>
                    {(repos.data?.repos || []).length > 0 && (
                        <div>
                            <div className="hint">CI results on branches you watch (Code view), when one fails or recovers:</div>
                            {(repos.data?.repos || []).map((repo) => (
                                <label key={repo.repo}>
                                    <input type="checkbox" checked={value.ciRepos.includes(repo.repo.toLowerCase())} data-testid="responsibility-ci-repo"
                                        onChange={(e) => onChange({ ...value, ciRepos: toggle(value.ciRepos, repo.repo.toLowerCase(), e.target.checked) })} />{' '}
                                    {repo.repo}
                                </label>
                            ))}
                        </div>
                    )}
                    {(followed.data?.sources || []).length > 0 && (
                        <div>
                            <div className="hint">Items you keep from sources you follow in this project:</div>
                            {(followed.data?.sources || []).map((source) => (
                                <label key={source.id}>
                                    <input type="checkbox" checked={value.followed.includes(source.id)} data-testid="responsibility-followed-source"
                                        onChange={(e) => onChange({ ...value, followed: toggle(value.followed, source.id, e.target.checked) })} />{' '}
                                    {source.label}
                                </label>
                            ))}
                        </div>
                    )}
                </>
            )}
        </fieldset>
    );
}
