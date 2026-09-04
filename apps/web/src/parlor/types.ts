export type Persona = {
    id: number;
    name: string;
    charter?: string;
    emoji?: string;
    color?: string;
    voiceId?: string | null;
    voiceName?: string | null;
    noteCount?: number;
};

export type Grounding = { id: number; title: string };
export type Attachment = { url: string; name: string };

export type ParlorMessage = {
    id?: number;
    role: 'user' | 'persona' | 'assistant';
    content: string;
    personaId?: number;
    personaName?: string;
    userId?: string;
    userName?: string;
    createdAt?: string;
    isError?: boolean;
    grounding?: Grounding[];
    attachments?: Attachment[];
    draft?: boolean;
    typing?: boolean;
};
