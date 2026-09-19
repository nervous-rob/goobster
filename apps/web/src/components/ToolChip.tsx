import { describeToolChip, chipHoverTitle } from '../lib/toolChipLabel';

/**
 * One tool-activity chip. Observatory/project calls show action + target
 * in the chip header so a phone can read them without hovering.
 */
export function ToolChip({
    name,
    argsPreview,
    resultPreview,
    running = false,
    isError = false,
    cached = false,
    durationMs
}: {
    name: string;
    argsPreview?: string;
    resultPreview?: string;
    running?: boolean;
    isError?: boolean;
    cached?: boolean;
    durationMs?: number;
}) {
    const { verb, context, header } = describeToolChip(name, argsPreview, { done: !running });
    const hover = chipHoverTitle(argsPreview, resultPreview);
    const meta = running
        ? ''
        : `${cached ? ' · cached' : ''}${typeof durationMs === 'number' && !cached ? ` · ${formatDuration(durationMs)}` : ''}`;
    const spoken = `${isError ? 'Failed: ' : ''}${header}${meta}`;

    return (
        <span
            className={`tool-chip${context ? ' has-context' : ''} ${running ? 'running' : isError ? 'failed' : 'done'}`}
            title={hover}
            aria-label={spoken}
        >
            <span className="tool-chip-head">
                {running
                    ? <><span className="tool-spinner" /> {verb}…</>
                    : <>{isError ? '⚠' : '✓'} {verb}{meta}</>}
            </span>
            {context ? <span className="tool-chip-context">{context}</span> : null}
        </span>
    );
}

function formatDuration(ms: number): string {
    if (ms < 1000) return '<1s';
    const seconds = ms / 1000;
    if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
    return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}
