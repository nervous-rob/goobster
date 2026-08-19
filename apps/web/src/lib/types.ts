export type Scope = {
    id: string;
    kind: 'dm' | 'guild';
    name: string;
    icon?: string | null;
    manageGuild?: boolean;
    graphAvailable?: boolean;
};

export type Me = {
    user: { id: string; name: string; avatar: string | null };
    bot: { id: string; name: string } | null;
    scopes: Scope[];
    maxInputLength: number;
    features: { observatory?: boolean };
};

export type AppConfig = {
    clientId: string;
    devMode: boolean;
    loginAvailable: boolean;
    maxInputLength: number;
    nextClient?: boolean;
};

export type Conversation = {
    id: number;
    title: string | null;
    messageCount?: number;
    lastMessageAt?: string | null;
    parentConversationId?: number | null;
    branchedFromMessageId?: number | null;
    shareToken?: string | null;
};

export type ChatMessage = {
    id: number;
    role: 'user' | 'assistant' | 'system';
    content: string;
    createdAt: string;
    attachments?: Array<{ url: string; name?: string }>;
    isError?: boolean;
};

export type ApiErrorShape = {
    status: number;
    code: string;
    message: string;
    details?: unknown;
};
