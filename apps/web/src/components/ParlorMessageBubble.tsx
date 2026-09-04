import { Markdown } from './Markdown';
import type { ParlorMessage, Persona } from '../parlor/types';
import { personaColor, personaGlyph, timeLabel } from '../parlor/persona';

/**
 * Shared parlor bubble used by the Parlor room and the project chat dock.
 * Keep rendering here so persona colors, glyphs, grounding chips, and
 * attachments cannot drift between the two surfaces.
 */
export function ParlorMessageBubble({
    message,
    meId,
    persona,
    requestGrant,
    showTimestamp = false,
    typingLabel = 'consulting their notes…',
    fallbackName = 'Goobster'
}: {
    message: ParlorMessage;
    meId: string;
    persona?: Persona;
    requestGrant: (text: string) => Promise<boolean>;
    showTimestamp?: boolean;
    typingLabel?: string;
    fallbackName?: string;
}) {
    if (message.role === 'user') {
        const other = message.userId && message.userId !== meId;
        return (
            <div className={`msg user${other ? ' from-member' : ''}`}>
                {other && <div className="member-byline">{message.userName || `User ${message.userId}`}</div>}
                <div className="msg-bubble">{message.content}</div>
                {showTimestamp && message.createdAt && <div className="msg-meta">{timeLabel(message.createdAt)}</div>}
            </div>
        );
    }
    const color = personaColor(persona || { id: message.personaId, color: undefined });
    return (
        <div className={`msg assistant persona-msg${message.isError ? ' error' : ''}`}>
            <div className="persona-byline" style={{ color }}>
                <span className="persona-dot small" style={{ background: color }}>
                    {personaGlyph(persona || { name: message.personaName })}
                </span>
                    {message.personaName || persona?.name || fallbackName}
                {message.typing ? <span className="hint"> {typingLabel}</span> : null}
            </div>
            <div className="msg-bubble" style={{ borderLeft: `3px solid ${color}` }}>
                {message.typing
                    ? <span className="typing"><i /><i /><i /></span>
                    : <Markdown source={message.content} requestGrant={requestGrant} />}
            </div>
            {message.attachments && message.attachments.length > 0 && (
                <div className="grounding">
                    {message.attachments.map((file) => (
                        <a key={file.url} className="gchip" href={file.url} target="_blank" rel="noreferrer">
                            📄 {file.name}
                        </a>
                    ))}
                </div>
            )}
            {message.grounding && message.grounding.length > 0 && (
                <div className="grounding">
                    📎 grounded on:
                    {message.grounding.map((note) => <span key={note.id} className="gchip">{note.title}</span>)}
                </div>
            )}
        </div>
    );
}
