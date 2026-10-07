export const SETUP_STEPS = [
    { id: 'welcome', label: 'Welcome' },
    { id: 'where', label: 'Where' },
    { id: 'features', label: 'Features' },
    { id: 'connections', label: 'Connections' },
    { id: 'database', label: 'Database' },
    { id: 'defaults', label: 'Defaults' },
    { id: 'access', label: 'Access' },
    { id: 'review', label: 'Review' },
    { id: 'progress', label: 'Install' },
    { id: 'first-run', label: 'Check' },
    { id: 'done', label: 'Open' }
] as const;

export type StepId = typeof SETUP_STEPS[number]['id'];

export function neighbours(id: string): { previous: string | null; next: string | null } {
    const index = SETUP_STEPS.findIndex((step) => step.id === id);
    return {
        previous: index > 0 ? SETUP_STEPS[index - 1].id : null,
        next: index >= 0 && index < SETUP_STEPS.length - 1 ? SETUP_STEPS[index + 1].id : null
    };
}

export type StepProps = { go: (step: string, id?: string | null) => void };
