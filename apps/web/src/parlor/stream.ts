import type { ToolEvent, TurnStep } from '../lib/types';
import type { ParlorMessage } from './types';

/**
 * Pure reducers for a parlor turn streaming into a transcript (the Parlor
 * room, its live session, and the project chat dock all share them). The
 * in-flight persona reply is the trailing non-user message flagged
 * `draft` or `typing`; it accumulates streamed text and a "Thinking"
 * timeline (`steps`) in the same shape the server persists, so a live
 * reply and a reloaded one render identically. Text streamed before a
 * tool call is interstitial thinking: it moves into the timeline instead
 * of being thrown away.
 */

type Speaker = { role: ParlorMessage['role']; personaId?: number; personaName?: string };

function inFlightIndex(messages: ParlorMessage[]): number {
    const index = messages.length - 1;
    const last = messages[index];
    return last && last.role !== 'user' && (last.draft || last.typing) ? index : -1;
}

/** Append streamed text to the in-flight reply (or open one for `speaker`). */
export function applyParlorDelta(messages: ParlorMessage[], delta: string, speaker: Speaker): ParlorMessage[] {
    const next = [...messages];
    const last = next[next.length - 1];
    if (last && last.role !== 'user' && (last.draft || last.typing || last.content === '')) {
        next[next.length - 1] = { ...last, content: (last.typing ? '' : last.content) + delta, typing: false, draft: true };
    } else {
        next.push({ ...speaker, content: delta, draft: true });
    }
    return next;
}

function settleStep(steps: TurnStep[], event: ToolEvent): TurnStep[] {
    let index = steps.findIndex((step) => step.type === 'tool' && step.running
        && (event.id !== undefined ? step.id === event.id : step.name === event.name));
    if (index === -1) index = steps.length;
    const next = [...steps];
    next[index] = {
        type: 'tool',
        id: event.id,
        name: event.name,
        cached: event.cached,
        isError: event.isError,
        argsPreview: steps[index]?.argsPreview ?? event.argsPreview,
        resultPreview: event.resultPreview,
        durationMs: event.durationMs,
        ...(event.card ? { card: event.card } : {}),
        running: false
    };
    return next;
}

/** Record one tool progress event on the in-flight reply's timeline. */
export function applyParlorTool(messages: ParlorMessage[], event: ToolEvent, speaker: Speaker): ParlorMessage[] {
    if (event.phase === 'admission') return messages;
    const next = [...messages];
    let index = inFlightIndex(next);
    if (index === -1) {
        next.push({ ...speaker, content: '', typing: true });
        index = next.length - 1;
    }
    const target = next[index];
    let steps = target.steps ? [...target.steps] : [];
    let content = target.content;
    if (event.phase === 'start') {
        if (!target.typing && content.trim()) steps.push({ type: 'text', content });
        content = '';
        steps.push({
            type: 'tool',
            id: event.id,
            name: event.name,
            cached: event.cached,
            argsPreview: event.argsPreview,
            running: true
        });
    } else {
        steps = settleStep(steps, event);
    }
    // Between tool rounds the reply shows the Thinking trail plus the
    // typing dots until the next round's text streams in.
    next[index] = { ...target, content, steps, typing: content === '', draft: content !== '' };
    return next;
}

/**
 * Replace the in-flight reply with the completed one. The live timeline
 * rides along unless the server sent its own (the persisted copy).
 */
export function applyParlorMessage(messages: ParlorMessage[], message: ParlorMessage): ParlorMessage[] {
    const index = inFlightIndex(messages);
    const liveSteps = index !== -1 ? messages[index].steps : undefined;
    const settled = messages.filter((m) => !m.draft && !m.typing);
    const steps = message.steps && message.steps.length > 0 ? message.steps : liveSteps;
    settled.push(steps && steps.length > 0 ? { ...message, steps } : message);
    return settled;
}

/**
 * The turn ended without a completed reply (stop, error, dropped stream):
 * keep what the reader already saw as a settled message, with any still
 * running tool marked stopped.
 */
export function settleParlorStream(messages: ParlorMessage[]): ParlorMessage[] {
    return messages
        .filter((m) => !(m.typing && !(m.steps && m.steps.length > 0)))
        .map((m) => (m.draft || m.typing
            ? {
                ...m,
                draft: false,
                typing: false,
                steps: m.steps?.map((step) => (step.running
                    ? { ...step, running: false, resultPreview: step.resultPreview ?? '(stopped)' }
                    : step))
            }
            : m));
}
