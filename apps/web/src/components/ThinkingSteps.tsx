import { useState } from 'react';
import { Markdown } from './Markdown';
import { ToolChip } from './ToolChip';
import { describeToolChip } from '../lib/toolChipLabel';
import type { TurnStep } from '../lib/types';

/**
 * The "Thinking" trail of one assistant reply: interstitial text the model
 * wrote between tool calls plus a chip per tool execution, collapsible so it
 * never crowds the answer. Renders the same shape live (mid-turn, expanded)
 * and from history (metadata.steps, collapsed by default).
 */

function thinkingHeader(steps: TurnStep[], live: boolean): string {
    const toolSteps = steps.filter((step) => step.type === 'tool');
    const runningStep = toolSteps.find((step) => step.running);
    if (live) {
        if (!runningStep) return 'Thinking…';
        const { header } = describeToolChip(runningStep.name || '', runningStep.argsPreview, { done: false });
        return `${header}…`;
    }
    // A single observatory/project call is the whole story — put its
    // target in the collapsed header so a phone never has to hover.
    if (toolSteps.length === 1 && toolSteps[0].name === 'observatory') {
        return describeToolChip('observatory', toolSteps[0].argsPreview, { done: true }).header;
    }
    return `Thinking · ${steps.length} step${steps.length === 1 ? '' : 's'}`;
}

export function ThinkingSteps({ steps, live = false, defaultOpen }: { steps: TurnStep[]; live?: boolean; defaultOpen?: boolean }) {
    // Starts expanded while the turn is streaming, collapsed for settled
    // messages; the reader can toggle either way at any time.
    const [open, setOpen] = useState(defaultOpen ?? live);
    if (steps.length === 0) return null;

    return (
        <div className={`thinking${live ? ' live' : ''}`}>
            <button
                type="button"
                className="thinking-summary"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span className="thinking-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                {live && !steps.some((step) => step.type === 'tool' && step.running)
                    ? <span className="tool-spinner" />
                    : <span aria-hidden="true">🧠</span>}
                <span>{thinkingHeader(steps, live)}</span>
            </button>
            {open && (
                <div className="thinking-body">
                    {steps.map((step, index) => (step.type === 'text'
                        ? (
                            <div key={index} className="thinking-text">
                                <Markdown source={step.content || ''} />
                            </div>
                        )
                        : (
                            <ToolChip
                                key={index}
                                name={step.name || ''}
                                argsPreview={step.argsPreview}
                                resultPreview={step.resultPreview}
                                running={step.running}
                                isError={step.isError}
                                cached={step.cached}
                                durationMs={step.durationMs}
                            />
                        )))}
                </div>
            )}
        </div>
    );
}
