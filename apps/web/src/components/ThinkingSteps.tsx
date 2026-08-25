import { useState } from 'react';
import { Markdown } from './Markdown';
import type { TurnStep } from '../lib/types';

/**
 * The "Thinking" trail of one assistant reply: interstitial text the model
 * wrote between tool calls plus a chip per tool execution, collapsible so it
 * never crowds the answer. Renders the same shape live (mid-turn, expanded)
 * and from history (metadata.steps, collapsed by default).
 */

const TOOL_LABELS: Record<string, [string, string]> = {
    performSearch: ['Searching the web', 'Searched the web'],
    generateImage: ['Generating an image', 'Generated an image'],
    runCode: ['Running code', 'Ran code'],
    searchGithubCode: ['Searching GitHub', 'Searched GitHub'],
    readGithubFile: ['Reading a GitHub file', 'Read a GitHub file'],
    searchNotion: ['Searching Notion', 'Searched Notion'],
    readNotionPage: ['Reading a Notion page', 'Read a Notion page'],
    rememberFact: ['Saving a memory', 'Saved a memory'],
    forgetFact: ['Removing a memory', 'Removed a memory'],
    scheduleFollowUp: ['Scheduling a follow-up', 'Scheduled a follow-up'],
    manageAutomations: ['Managing your automations', 'Managed your automations'],
    manageParlor: ['Working in your Parlor', 'Worked in your Parlor'],
    stockQuote: ['Checking stock prices', 'Checked stock prices'],
    rollDice: ['Rolling dice', 'Rolled dice']
};

export function toolLabel(name: string, done: boolean): string {
    const entry = TOOL_LABELS[name];
    if (entry) return entry[done ? 1 : 0];
    const words = String(name).replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return done ? `Finished: ${words}` : `Working: ${words}`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

/** Hover context for a tool chip: what it was asked and what came back. */
function chipTitle(step: TurnStep): string | undefined {
    const parts: string[] = [];
    if (step.argsPreview && step.argsPreview !== '{}') parts.push(step.argsPreview);
    if (step.resultPreview) parts.push(`→ ${step.resultPreview}`);
    return parts.length > 0 ? parts.join('\n') : undefined;
}

export function ThinkingSteps({ steps, live = false }: { steps: TurnStep[]; live?: boolean }) {
    // Starts expanded while the turn is streaming, collapsed for settled
    // messages; the reader can toggle either way at any time.
    const [open, setOpen] = useState(live);
    if (steps.length === 0) return null;

    const runningStep = steps.find((step) => step.type === 'tool' && step.running);
    const label = live
        ? (runningStep ? `${toolLabel(runningStep.name || '', false)}…` : 'Thinking…')
        : `Thinking · ${steps.length} step${steps.length === 1 ? '' : 's'}`;

    return (
        <div className={`thinking${live ? ' live' : ''}`}>
            <button
                type="button"
                className="thinking-summary"
                aria-expanded={open}
                onClick={() => setOpen((value) => !value)}
            >
                <span className="thinking-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
                {live && !runningStep ? <span className="tool-spinner" /> : <span aria-hidden="true">🧠</span>}
                <span>{label}</span>
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
                            <span
                                key={index}
                                className={`tool-chip ${step.running ? 'running' : step.isError ? 'failed' : 'done'}`}
                                title={chipTitle(step)}
                            >
                                {step.running
                                    ? <><span className="tool-spinner" /> {toolLabel(step.name || '', false)}…</>
                                    : <>
                                        {step.isError ? '⚠' : '✓'} {toolLabel(step.name || '', true)}
                                        {step.cached ? ' · cached' : ''}
                                        {typeof step.durationMs === 'number' && !step.cached ? ` · ${formatDuration(step.durationMs)}` : ''}
                                    </>}
                            </span>
                        )))}
                </div>
            )}
        </div>
    );
}
