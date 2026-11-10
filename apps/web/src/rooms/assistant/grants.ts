import type { Responsibility, ResponsibilityOperation } from '../../lib/types';

/** Plain words for what a responsibility grants. */

export type Project = { id: number; slug: string; name: string; ownerId: string };

const OPERATION_TEXT: Record<string, string> = {
    read: 'read',
    research: 'run research expeditions',
    'kg.generated.add': 'add generated notes',
    'kg.generated.amend': 'amend generated notes',
    'kg.saved.propose': 'suggest changes to notes you saved (you apply them)',
    'kg.saved.amend': 'amend notes you saved directly',
    'kg.edge': 'connect notes',
    'kg.archive': 'archive notes',
    'file.edit': 'edit files',
    'sandbox.run': 'run code in the sandbox',
    'plan.step.execute': 'carry out assistant steps of its approved plan',
    'process.repair': 'repair',
    'process.pause': 'pause',
    'process.archive': 'archive',
    'cleanup.exact': 'clean up',
    'repo.commit': 'commit',
    'repo.push': 'push',
    'pr.create': 'open pull requests',
    'external.write': 'write to an outside service'
};

function describeResource(entry: ResponsibilityOperation, projects: Map<string, Project>): string {
    const resource = entry.resource;
    switch (resource.kind) {
        case 'knowledge': return 'your knowledge';
        case 'web': return 'the web';
        case 'project': {
            const names = (resource.ids || []).map((id) => projects.get(id)?.name || `project #${id}`).join(', ');
            return `${names}${resource.paths?.length ? ` (only ${resource.paths.join(', ')})` : ''}`;
        }
        case 'repository':
            return `${(resource.ids || []).join(', ')}${resource.branches?.length ? ` on ${resource.branches.join(', ')}` : ''}`;
        case 'process': return (resource.ids || []).join(', ');
        default: return (resource.ids || []).join(', ') || resource.kind;
    }
}

/** Pushes and pull requests a day when a responsibility sets no `externalOperations` (delegated_runs.md). */
export const DEFAULT_EXTERNAL_OPERATIONS = 2;
export const MAX_EXTERNAL_OPERATIONS = 20;

/** True when the grant lets work leave this installation (a push, a pull request). */
export function reachesGitHub(operations: ResponsibilityOperation[]): boolean {
    return operations.some((entry) => entry.operation === 'repo.push' || entry.operation === 'pr.create');
}

/** How many pushes and pull requests a day the responsibility allows. */
export function externalOperationsPerDay(budgets: Record<string, number> | undefined): number {
    const set = budgets?.externalOperations;
    return Number.isInteger(set) ? Math.min(set as number, MAX_EXTERNAL_OPERATIONS) : DEFAULT_EXTERNAL_OPERATIONS;
}

/** "read, research the web · add generated notes in your knowledge" */
export function describeGrants(operations: ResponsibilityOperation[], projects: Map<string, Project>): string[] {
    const byResource = new Map<string, string[]>();
    for (const entry of operations) {
        const where = describeResource(entry, projects);
        byResource.set(where, [...(byResource.get(where) || []), OPERATION_TEXT[entry.operation] || entry.operation]);
    }
    return [...byResource.entries()].map(([where, verbs]) => `${verbs.join(', ')}: ${where}`);
}

/** Where it takes requests addressed to the assistant, in plain words (delegated_conversation_requests.md). */
export function describeListening(item: Pick<Responsibility, 'scopes'>, name: string): string | null {
    const sources = item.scopes?.sources || [];
    const places = [
        sources.includes('project_chat') ? 'its project\'s conversations' : null,
        sources.includes('parlor') ? 'your discussions' : null
    ].filter(Boolean);
    return places.length ? `Takes requests you address to ${name} in ${places.join(' and ')}` : null;
}

/** The wider sources it notices work from, in plain words (delegated_opportunity_sources.md). */
export function describeNoticing(item: Pick<Responsibility, 'scopes'>): string | null {
    const sources = item.scopes?.sources || [];
    const things = [
        sources.includes('personal_chat') ? 'requests in your own chats' : null,
        sources.includes('followed_source') ? 'items you keep from sources you follow' : null,
        sources.includes('job_failure') ? 'new causes of failed project runs' : null,
        sources.includes('ci_verdict') ? 'CI results on watched branches' : null
    ].filter(Boolean);
    return things.length ? `Notices ${things.join(', ')}` : null;
}

/** Whether its findings go to the project's members as well (delegated_project_findings.md). */
export function describeSharing(item: Pick<Responsibility, 'scopes' | 'projectId'>): string | null {
    return item.projectId && item.scopes?.audience === 'project' ? 'Shares what it finds with the project\'s members' : null;
}
