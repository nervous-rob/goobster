import { useState, type FormEvent } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import { projectPath } from '../../lib/rooms';
import { useToast } from '../../hooks/useToast';
import { Modal } from '../../components/Modal';
import type { Project } from './types';

/**
 * Direct creation (ADR 0009): a name and an optional goal make an empty
 * organizational container through the authorized service - no model
 * call. Richer setup (assets, first runs) is what ✨ Command is for.
 */
export function CreateProjectForm({ onClose }: { onClose: () => void }) {
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [name, setName] = useState('');
    const [goal, setGoal] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!name.trim()) {
            setError('A project needs a name.');
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const result = await api.createProject({ name: name.trim(), goal: goal.trim() || undefined }) as { project: Project };
            await queryClient.invalidateQueries({ queryKey: keys.observatory });
            toast(`Created "${result.project.name}".`);
            onClose();
            const ownerId = result.project.ownerId as string;
            void navigate({ to: projectPath({ owner: ownerId, slug: result.project.slug }) as never });
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal onClose={onClose}>
            <form onSubmit={submit} className="project-create" data-tour="project-create-form">
                <h2>New project</h2>
                <p className="hint">
                    A project is a durable home for one piece of work: its plan, runs, files, apps,
                    knowledge and the people on it. Start with a name and, if you have one, the goal.
                </p>
                <label className="field">
                    <span>Name</span>
                    <input
                        className="input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Emergence study"
                        maxLength={60}
                        autoFocus
                        required
                        data-tour="project-create-name"
                    />
                </label>
                <label className="field">
                    <span>Goal <span className="hint">(optional)</span></span>
                    <textarea
                        className="input"
                        rows={3}
                        value={goal}
                        onChange={(e) => setGoal(e.target.value)}
                        placeholder="What should this project find out, build, or decide?"
                        maxLength={600}
                        data-tour="project-create-goal"
                    />
                </label>
                {error ? <div className="row-meta obs-error" role="alert">{error}</div> : null}
                <div className="modal-actions">
                    <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
                    <button type="submit" className="btn primary" disabled={busy || !name.trim()}>
                        {busy ? 'Creating…' : 'Create project'}
                    </button>
                </div>
            </form>
        </Modal>
    );
}
