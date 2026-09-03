import type { ReactNode } from 'react';
import { Markdown } from './Markdown';
import { ThinkingSteps } from './ThinkingSteps';
import type { LocalTurnMessage } from '../hooks/useChatTurn';

function timeLabel(iso?: string): string {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function ChatTranscript({
    messages,
    onNotify,
    requestGrant,
    onSaveToProject,
    renderActions,
    empty
}: {
    messages: LocalTurnMessage[];
    onNotify?: (message: string, isError?: boolean) => void;
    requestGrant?: (message: string) => Promise<boolean>;
    onSaveToProject?: (info: {
        source: string;
        language: string;
        title?: string;
        grants?: { observatoryRead: string[] };
        message: LocalTurnMessage;
    }) => void;
    renderActions?: (message: LocalTurnMessage) => ReactNode;
    empty?: ReactNode;
}) {
    if (messages.length === 0) {
        return empty ? <>{empty}</> : null;
    }
    return (
        <div className="chat-log">
            {messages.map((message, index) => (
                <div
                    key={message.id && message.id > 0 ? message.id : `local-${index}`}
                    className={`msg ${message.role}${message.isError ? ' error' : ''}`}
                >
                    {message.images && message.images.length > 0 && (
                        <div className="msg-images">
                            {message.images.map((image) => (
                                <img key={image.name} src={image.dataUrl} alt={image.name} />
                            ))}
                        </div>
                    )}
                    {message.role === 'assistant' && message.steps && message.steps.length > 0 && (
                        <ThinkingSteps steps={message.steps} live={Boolean(message.draft)} />
                    )}
                    {(message.typing || message.content || message.attachments?.length) ? (
                        <div className="msg-bubble">
                            {message.typing
                                ? <span className="typing"><i /><i /><i /></span>
                                : (
                                    <Markdown
                                        source={message.content}
                                        attachments={message.attachments}
                                        onNotify={onNotify}
                                        requestGrant={requestGrant}
                                        onSaveToProject={onSaveToProject
                                            ? (info) => onSaveToProject({ ...info, message })
                                            : undefined}
                                    />
                                )}
                        </div>
                    ) : null}
                    {renderActions ? <div className="msg-actions">{renderActions(message)}</div> : null}
                    {message.createdAt && !message.draft && (
                        <div className="msg-meta">{timeLabel(message.createdAt)}</div>
                    )}
                </div>
            ))}
        </div>
    );
}
