import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Modal } from '../../components/Modal';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';

export type PersonaFields = {
    id: number;
    name: string;
    charter?: string;
    emoji?: string | null;
    color?: string | null;
    voiceId?: string | null;
    voiceName?: string | null;
    noteCount?: number;
};

type Voice = { id: string; name: string };

/**
 * The full persona editor (create + edit): name, emoji, color, charter,
 * an ElevenLabs voice for live sessions (hidden when the server has no
 * key - graceful degradation), and Delete on existing personas.
 */
export function PersonaModal({
    persona, defaultColor, onClose, onSaved, onDeleted
}: {
    persona: PersonaFields | null;
    defaultColor: string;
    onClose: () => void;
    onSaved: (saved: PersonaFields) => void;
    onDeleted: () => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const [name, setName] = useState(persona?.name || '');
    const [emoji, setEmoji] = useState(persona?.emoji || '');
    const [color, setColor] = useState(persona?.color || defaultColor);
    const [charter, setCharter] = useState(persona?.charter || '');
    const [voice, setVoice] = useState(persona?.voiceId || '');

    // The ElevenLabs voice library; an error (no key, old server) simply
    // hides the picker - voices are optional everywhere.
    const voicesQ = useQuery({
        queryKey: ['parlor-voices'],
        queryFn: () => api.parlorVoices() as Promise<{ voices: Voice[] }>,
        staleTime: Infinity,
        retry: false
    });
    const voices = voicesQ.data?.voices || [];
    const voicesAvailable = voices.length > 0;
    // A voice configured outside the library list stays selectable
    const extraVoice = persona?.voiceId && !voices.some((v) => v.id === persona.voiceId)
        ? { id: persona.voiceId, name: persona.voiceName || persona.voiceId }
        : null;

    const save = useMutation({
        mutationFn: async () => {
            const fields = {
                name: name.trim(),
                emoji: emoji.trim() || null,
                color,
                charter: charter.trim()
            };
            const saved = (persona
                ? await api.parlorUpdatePersona(persona.id, fields)
                : await api.parlorCreatePersona(fields)) as PersonaFields;
            // Voice resolves against ElevenLabs at save time - a bad pick
            // fails loudly here, never mid-session.
            if (voicesAvailable && voice !== (persona?.voiceId || '')) {
                try {
                    await api.parlorSetPersonaVoice(saved.id, voice);
                } catch (error) {
                    toast(`Voice not saved: ${(error as Error).message}`, true);
                }
            }
            return saved;
        },
        onSuccess: (saved) => {
            toast(persona ? 'Persona updated.' : `${saved.name} joined the parlor.`);
            onSaved(saved);
        },
        onError: (error) => toast((error as Error).message, true)
    });

    async function remove() {
        if (!persona) return;
        if (!await confirm(
            `Retire ${persona.name}? Their whole knowledge workspace (${persona.noteCount ?? 0} notes) goes with them.`)) return;
        try {
            await api.parlorDeletePersona(persona.id);
            toast(`${persona.name} has left the parlor.`);
            onDeleted();
        } catch (error) {
            toast((error as Error).message, true);
        }
    }

    return (
        <Modal onClose={onClose}>
            <h2>{persona ? 'Edit persona' : 'New persona'}</h2>
            <div className="form-grid">
                <label>Name
                    <input className="input" maxLength={48} placeholder="The Researcher" value={name} autoFocus onChange={(e) => setName(e.target.value)} />
                </label>
                <div className="form-row">
                    <label>Emoji
                        <input className="input" maxLength={8} placeholder="🔬" style={{ width: 70 }} value={emoji} onChange={(e) => setEmoji(e.target.value)} />
                    </label>
                    <label>Color
                        <input type="color" className="color-input" value={color} onChange={(e) => setColor(e.target.value)} />
                    </label>
                </div>
                <label>Charter <span className="hint">who this persona is and how it thinks</span>
                    <textarea
                        className="input"
                        rows={5}
                        maxLength={2000}
                        placeholder="You are a careful researcher. You care about evidence..."
                        value={charter}
                        onChange={(e) => setCharter(e.target.value)}
                    />
                </label>
                {voicesAvailable && (
                    <label>Voice <span className="hint">how they sound in live sessions</span>
                        <select className="input" value={voice} onChange={(e) => setVoice(e.target.value)}>
                            <option value="">Default (auto-assigned)</option>
                            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                            {extraVoice && <option value={extraVoice.id}>{extraVoice.name}</option>}
                        </select>
                    </label>
                )}
            </div>
            <div className="modal-actions">
                {persona && <button type="button" className="btn danger" onClick={() => void remove()}>Delete</button>}
                <span style={{ flex: 1 }} />
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button
                    type="button"
                    className="btn primary"
                    disabled={save.isPending || !name.trim() || !charter.trim()}
                    onClick={() => save.mutate()}
                >{persona ? 'Save' : 'Create'}</button>
            </div>
        </Modal>
    );
}
