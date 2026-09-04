import type { ParlorMessage, Persona } from '../parlor/types';
import { ParlorMessageBubble } from './ParlorMessageBubble';

/**
 * Shared transcript renderer for any parlor conversation — the Parlor
 * room and the project chat dock. Chrome (header, composer, seats,
 * empty states) stays with the caller; message appearance must not.
 */
export function ParlorConversationView({
    messages,
    meId,
    personaById,
    requestGrant,
    showTimestamp = false,
    typingLabel,
    fallbackName
}: {
    messages: ParlorMessage[];
    meId: string;
    personaById: (id?: number) => Persona | undefined;
    requestGrant: (text: string) => Promise<boolean>;
    showTimestamp?: boolean;
    typingLabel?: string;
    fallbackName?: string;
}) {
    return (
        <>
            {messages.map((message, index) => (
                <ParlorMessageBubble
                    key={message.id ?? `s-${index}`}
                    message={message}
                    meId={meId}
                    persona={personaById(message.personaId)}
                    requestGrant={requestGrant}
                    showTimestamp={showTimestamp}
                    typingLabel={typingLabel}
                    fallbackName={fallbackName}
                />
            ))}
        </>
    );
}
