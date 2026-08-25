import { useCallback, useReducer } from 'react';
import type { ChatMessage, ToolEvent, TurnStep } from '../lib/types';

/**
 * Live turn state for the chat surfaces: one reducer owning the streamed
 * transcript of the in-flight turn, so nothing the model showed the user is
 * ever thrown away mid-turn.
 *
 * The core rule this fixes: text streamed before a tool call used to be
 * deleted when the tool started. Here it is *moved* into the turn's steps
 * timeline instead, and tool chips accumulate in the same timeline - the
 * exact shape the server persists (metadata.steps), so live turns and
 * reloaded history render identically.
 */

export type LocalTurnMessage = ChatMessage & {
    draft?: boolean;
    typing?: boolean;
    images?: Array<{ dataUrl: string; name: string }>;
};

type TurnState = {
    active: boolean;
    /** Settled messages: the sent user message(s) and completed replies. */
    messages: LocalTurnMessage[];
    /** Timeline of the reply being generated (text + tool steps). */
    steps: TurnStep[];
    /** Streamed text not yet classified (interstitial vs final answer). */
    draft: string;
    typing: boolean;
};

type TurnAction =
    | { kind: 'begin'; message: LocalTurnMessage; keep: boolean }
    | { kind: 'typing' }
    | { kind: 'delta'; text: string }
    | { kind: 'tool'; event: ToolEvent }
    | { kind: 'message'; message: LocalTurnMessage }
    | { kind: 'end' }
    | { kind: 'reset' };

const INITIAL: TurnState = { active: false, messages: [], steps: [], draft: '', typing: false };

let localId = -1;
function nextLocalId(): number {
    return localId--;
}

function settleTool(steps: TurnStep[], event: ToolEvent): TurnStep[] {
    // Pair by id when the server sent one; otherwise the oldest still-running
    // chip with the same name.
    let index = steps.findIndex((step) => step.type === 'tool' && step.running
        && (event.id !== undefined ? step.id === event.id : step.name === event.name));
    if (index === -1) index = steps.length;
    const settled: TurnStep = {
        type: 'tool',
        id: event.id,
        name: event.name,
        cached: event.cached,
        isError: event.isError,
        argsPreview: steps[index]?.argsPreview ?? event.argsPreview,
        resultPreview: event.resultPreview,
        durationMs: event.durationMs,
        running: false
    };
    const next = [...steps];
    next[index] = settled;
    return next;
}

function reduce(state: TurnState, action: TurnAction): TurnState {
    switch (action.kind) {
        case 'begin':
            return {
                active: true,
                messages: action.keep ? [...state.messages, action.message] : [action.message],
                steps: [],
                draft: '',
                typing: false
            };
        case 'typing':
            return state.typing ? state : { ...state, typing: true };
        case 'delta':
            return { ...state, draft: state.draft + action.text, typing: false };
        case 'tool': {
            if (action.event.phase === 'start') {
                const steps = [...state.steps];
                // The streamed text before this tool call is interstitial
                // thinking - keep it in the timeline instead of deleting it.
                if (state.draft.trim()) steps.push({ type: 'text', content: state.draft });
                steps.push({
                    type: 'tool',
                    id: action.event.id,
                    name: action.event.name,
                    cached: action.event.cached,
                    argsPreview: action.event.argsPreview,
                    running: true
                });
                return { ...state, steps, draft: '', typing: false };
            }
            return { ...state, steps: settleTool(state.steps, action.event), typing: false };
        }
        case 'message': {
            // The completed reply supersedes the draft; the accumulated
            // timeline rides on the message, exactly like a history row.
            const message: LocalTurnMessage = {
                ...action.message,
                steps: state.steps.length > 0 ? state.steps : undefined
            };
            return { ...state, messages: [...state.messages, message], steps: [], draft: '', typing: false };
        }
        case 'end': {
            if (!state.active && !state.typing && state.draft === '') return state;
            // A turn that ends while text or steps are still un-settled (an
            // abort, a dead stream) keeps them visible as a plain message
            // rather than losing what the user already read.
            if (state.draft.trim() || state.steps.length > 0) {
                const steps = state.steps.map((step) => (step.running
                    ? { ...step, running: false, resultPreview: step.resultPreview ?? '(stopped)' }
                    : step));
                const message: LocalTurnMessage = {
                    id: nextLocalId(),
                    role: 'assistant',
                    content: state.draft,
                    createdAt: new Date().toISOString(),
                    steps: steps.length > 0 ? steps : undefined
                };
                return { active: false, messages: [...state.messages, message], steps: [], draft: '', typing: false };
            }
            return { ...state, active: false, typing: false };
        }
        case 'reset':
            return INITIAL;
        default:
            return state;
    }
}

export function useChatTurn() {
    const [state, dispatch] = useReducer(reduce, INITIAL);

    const begin = useCallback((message: Omit<LocalTurnMessage, 'id' | 'createdAt'>, { keep = false } = {}) => {
        dispatch({
            kind: 'begin',
            keep,
            message: { id: nextLocalId(), createdAt: new Date().toISOString(), ...message }
        });
    }, []);
    const onTyping = useCallback(() => dispatch({ kind: 'typing' }), []);
    const onDelta = useCallback((text: string) => dispatch({ kind: 'delta', text }), []);
    const onTool = useCallback((event: ToolEvent) => dispatch({ kind: 'tool', event }), []);
    const onMessage = useCallback((message: Omit<LocalTurnMessage, 'id' | 'createdAt'>) => {
        dispatch({
            kind: 'message',
            message: { id: nextLocalId(), createdAt: new Date().toISOString(), ...message }
        });
    }, []);
    const end = useCallback(() => dispatch({ kind: 'end' }), []);
    const reset = useCallback(() => dispatch({ kind: 'reset' }), []);

    // The reply being generated, as a renderable pseudo-message: the steps
    // timeline plus whatever text is currently streaming.
    const pending: LocalTurnMessage | null = state.active && (state.typing || state.draft !== '' || state.steps.length > 0)
        ? {
            id: 0,
            role: 'assistant',
            content: state.draft,
            createdAt: '',
            draft: true,
            typing: state.typing && state.draft === '' && state.steps.length === 0,
            steps: state.steps.length > 0 ? state.steps : undefined
        }
        : null;

    return {
        active: state.active,
        messages: state.messages,
        pending,
        begin,
        onTyping,
        onDelta,
        onTool,
        onMessage,
        end,
        reset
    };
}
