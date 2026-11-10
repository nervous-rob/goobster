import type { ResponsibilityOperation } from '../../lib/types';

/** Plain words for what a responsibility grants. */

export type Project = { id: number; slug: string; name: string; ownerId: string };

const OPERATION_TEXT: Record<string, string> = {
    read: 'read',
    research: 'run research expeditions',
    'kg.generated.add': 'add generated notes',
    'kg.generated.amend': 'amend generated notes',
    'kg.saved.amend': 'amend notes you saved',
    'kg.edge': 'connect notes',
    'kg.archive': 'archive notes',
    'file.edit': 'edit files',
    'sandbox.run': 'run code in the sandbox',
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

/** "read, research the web · add generated notes in your knowledge" */
export function describeGrants(operations: ResponsibilityOperation[], projects: Map<string, Project>): string[] {
    const byResource = new Map<string, string[]>();
    for (const entry of operations) {
        const where = describeResource(entry, projects);
        byResource.set(where, [...(byResource.get(where) || []), OPERATION_TEXT[entry.operation] || entry.operation]);
    }
    return [...byResource.entries()].map(([where, verbs]) => `${verbs.join(', ')}: ${where}`);
}
