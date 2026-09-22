import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, streamObservatoryCommand } from '../../lib/api';
import { keys } from '../../lib/query';
import { useMe } from '../../hooks/useSession';
import { useToast } from '../../hooks/useToast';
import { Markdown } from '../../components/Markdown';
import { Modal } from '../../components/Modal';
import { ToolChip } from '../../components/ToolChip';

type CommandChip = { name: string; phase: string; isError?: boolean; argsPreview?: string };

export type CommandState = {
    active: boolean;
    label: string;
    draft: string;
    error: boolean;
    chips: CommandChip[];
};

export type CommandTarget = { slug: string; ownerId: string; name?: string } | null;

/** Why the ✨ Command controls are unavailable, in words a person can act on. */
export const EXECUTION_OFF = 'Code execution is off on this installation. Projects can be organized here, but Goobster cannot run commands, runs or renders in them.';

/**
 * The ✨ Command turn: one agent turn with the observatory tool, streamed
 * into a strip under the header. It exists to *run* things, so it is
 * gated on execution (ADR 0009) - the list and every view stay usable
 * without it.
 */
export function useProjectCommand() {
    const toast = useToast();
    const queryClient = useQueryClient();
    const [command, setCommand] = useState<CommandState | null>(null);

    async function run(instructions: string, target: CommandTarget) {
        const text = instructions.trim();
        if (!text) {
            toast('Tell Goobster what to do first.', true);
            return;
        }
        const name = target?.name || target?.slug;
        setCommand({
            active: true,
            label: target ? `Commanding "${name}"…` : 'Commanding Projects…',
            draft: '',
            error: false,
            chips: []
        });
        let draft = '';
        let finalShown = false;
        try {
            await streamObservatoryCommand(
                { project: target?.slug ?? null, owner: target?.ownerId ?? null, instructions: text },
                {
                    onTool: (event) => {
                        setCommand((prev) => {
                            if (!prev) return prev;
                            const chips = [...prev.chips];
                            if (event.phase === 'start') {
                                chips.push({ name: event.name, phase: 'start', argsPreview: event.argsPreview });
                            } else {
                                for (let i = chips.length - 1; i >= 0; i--) {
                                    if (chips[i].name === event.name && chips[i].phase === 'start') {
                                        chips[i] = {
                                            name: event.name,
                                            phase: 'result',
                                            isError: event.isError,
                                            argsPreview: chips[i].argsPreview ?? event.argsPreview
                                        };
                                        break;
                                    }
                                }
                            }
                            return { ...prev, chips };
                        });
                    },
                    onDelta: (delta) => {
                        if (finalShown) return;
                        draft += delta;
                        setCommand((prev) => prev ? { ...prev, draft } : prev);
                    },
                    onMessage: (message) => {
                        finalShown = true;
                        let markdown = message.content || '';
                        for (const attachment of message.attachments || []) {
                            markdown += `\n\n📎 [${attachment.name || 'file'}](${attachment.url})`;
                        }
                        setCommand((prev) => prev ? { ...prev, draft: markdown, error: Boolean(message.isError) } : prev);
                    },
                    onError: (error) => {
                        setCommand((prev) => prev ? { ...prev, error: true, draft: error.message || 'Something went wrong.' } : prev);
                    }
                }
            );
            setCommand((prev) => prev ? { ...prev, active: false, label: target ? `Command finished — "${name}"` : 'Command finished' } : prev);
        } catch (error) {
            setCommand((prev) => prev ? { ...prev, active: false, error: true, label: 'Command failed', draft: (error as Error).message } : prev);
        } finally {
            await queryClient.invalidateQueries({ queryKey: keys.observatory });
        }
    }

    return { command, run, dismiss: () => setCommand(null) };
}

export function CommandStrip({ command, onDismiss }: { command: CommandState | null; onDismiss: () => void }) {
    const toast = useToast();
    if (!command) return null;
    return (
        <div className="obs-command">
            <div className="obs-command-head">
                <span>{command.active ? <span className="tool-spinner" /> : (command.error ? '⚠' : '✨')}</span>
                <strong>{command.label}</strong>
                <span style={{ flex: 1 }} />
                {command.active
                    ? <button type="button" className="btn danger" onClick={() => { void api.stop(); }}>◼ Stop</button>
                    : <button type="button" className="btn subtle" onClick={onDismiss}>✕</button>}
            </div>
            <div className="obs-command-strip">
                {command.chips.map((chip, index) => (
                    <ToolChip
                        key={`${chip.name}-${index}`}
                        name={chip.name}
                        argsPreview={chip.argsPreview}
                        running={chip.phase === 'start'}
                        isError={chip.isError}
                    />
                ))}
            </div>
            <div className={`obs-command-reply${command.error ? ' error' : ''}`}>
                <Markdown source={command.draft} onNotify={toast} />
            </div>
        </div>
    );
}

/** The header's ✨ Command button: opens the modal, or explains why it cannot. */
export function CommandButton({ onOpen, big = false, label = '✨ Command' }: { onOpen: () => void; big?: boolean; label?: string }) {
    const me = useMe();
    const toast = useToast();
    const executionOn = Boolean(me.features?.observatory);
    return (
        <button
            type="button"
            className={`btn primary${big ? ' big' : ''}${executionOn ? '' : ' is-muted'}`}
            aria-disabled={!executionOn}
            title={executionOn ? 'Give Goobster instructions for this project' : EXECUTION_OFF}
            data-tour="project-command"
            onClick={() => (executionOn ? onOpen() : toast(EXECUTION_OFF, true))}
        >{label}</button>
    );
}

export function CommandModal({
    target, busy, onClose, onRun
}: {
    target: CommandTarget;
    busy: boolean;
    onClose: () => void;
    onRun: (instructions: string) => void;
}) {
    const [instructions, setInstructions] = useState('');
    const name = target?.name || target?.slug;
    return (
        <Modal onClose={onClose} wide>
            <h2>{target ? `Command "${name}"` : 'Command Projects'}</h2>
            <p className="hint">
                {target
                    ? 'Goobster continues this project with your instructions — running code, starting runs, or rendering.'
                    : 'Goobster acts across all your projects — it can create projects, start runs, and render results.'}
            </p>
            <textarea
                className="input"
                rows={5}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="What should Goobster do?"
                autoFocus
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        onRun(instructions);
                    }
                }}
            />
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={busy} onClick={() => onRun(instructions)}>Run</button>
            </div>
        </Modal>
    );
}
