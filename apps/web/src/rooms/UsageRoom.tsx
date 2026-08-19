import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';

type DayRow = { day: string; inputTokens?: number; outputTokens?: number; calls?: number };
type ModelRow = { provider: string; model: string; calls: number; inputTokens: number; outputTokens: number };
type OperationRow = { operation: string; calls: number; totalTokens?: number };
type UsagePayload = {
    days: number;
    totals: { calls: number; inputTokens: number; outputTokens: number };
    byDay: DayRow[];
    byModel: ModelRow[];
    byOperation: OperationRow[];
};

type DayPoint = {
    key: string;
    label: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
};

const PERIODS = [7, 30, 90] as const;

function formatTokens(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function daySeries(byDay: DayRow[], windowDays: number): DayPoint[] {
    const byKey = new Map(byDay.map((d) => [d.day, d]));
    const series: DayPoint[] = [];
    const now = new Date();
    for (let i = windowDays - 1; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const key = date.toISOString().slice(0, 10);
        const row = byKey.get(key);
        series.push({
            key,
            label: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
            inputTokens: row?.inputTokens || 0,
            outputTokens: row?.outputTokens || 0,
            calls: row?.calls || 0
        });
    }
    return series;
}

function drawChart(canvas: HTMLCanvasElement, series: DayPoint[]): void {
    const styles = getComputedStyle(document.body);
    const colors = {
        input: styles.getPropertyValue('--accent').trim() || '#7c8cff',
        output: styles.getPropertyValue('--ok').trim() || '#59d18c',
        grid: styles.getPropertyValue('--border').trim() || '#2a2f40',
        text: styles.getPropertyValue('--text-dim').trim() || '#9aa3b8'
    };
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 220;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const pad = { left: 44, right: 8, top: 10, bottom: 22 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...series.map((d) => d.inputTokens + d.outputTokens));

    ctx.strokeStyle = colors.grid;
    ctx.fillStyle = colors.text;
    ctx.font = '11px system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 3; i++) {
        const y = pad.top + plotH - (plotH * i / 3);
        ctx.beginPath();
        ctx.moveTo(pad.left, y);
        ctx.lineTo(width - pad.right, y);
        ctx.stroke();
        ctx.fillText(formatTokens(Math.round(max * i / 3)), 4, y + 4);
    }

    const step = plotW / Math.max(series.length, 1);
    const barW = Math.max(2, Math.min(26, step * 0.7));
    series.forEach((d, i) => {
        const x = pad.left + step * i + (step - barW) / 2;
        const inputH = plotH * (d.inputTokens / max);
        const outputH = plotH * (d.outputTokens / max);
        const base = pad.top + plotH;
        ctx.fillStyle = colors.input;
        ctx.fillRect(x, base - inputH, barW, inputH);
        ctx.fillStyle = colors.output;
        ctx.fillRect(x, base - inputH - outputH, barW, outputH);
    });

    ctx.fillStyle = colors.text;
    const every = Math.ceil(series.length / Math.max(1, Math.floor(plotW / 46)));
    series.forEach((d, i) => {
        if (i % every !== 0 && i !== series.length - 1) return;
        const x = pad.left + step * i + step / 2;
        ctx.textAlign = 'center';
        ctx.fillText(d.label, x, height - 6);
    });
}

export function UsageRoom() {
    const toast = useToast();
    const [days, setDays] = useState<typeof PERIODS[number]>(30);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const usage = useQuery({
        queryKey: keys.usage(days),
        queryFn: () => api.usage(days) as Promise<UsagePayload>
    });

    useEffect(() => {
        if (usage.error) toast((usage.error as Error).message, true);
    }, [usage.error, toast]);

    const stats = usage.data;
    const total = stats ? stats.totals.inputTokens + stats.totals.outputTokens : 0;
    const series = useMemo(
        () => (stats ? daySeries(stats.byDay || [], stats.days) : []),
        [stats]
    );

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !stats || (total === 0 && stats.totals.calls === 0)) return;
        const paint = () => drawChart(canvas, series);
        const frame = requestAnimationFrame(paint);
        const observer = new ResizeObserver(() => paint());
        observer.observe(canvas);
        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
        };
    }, [stats, series, total]);

    return (
        <main className="pane next-pane is-in" id="pane-usage">
            <header className="pane-header">
                <h1>Usage</h1>
                <div className="segment" role="tablist" aria-label="Period">
                    {PERIODS.map((period) => (
                        <button
                            key={period}
                            type="button"
                            className={`segment-btn${days === period ? ' active' : ''}`}
                            onClick={() => setDays(period)}
                        >
                            {period}d
                        </button>
                    ))}
                </div>
            </header>
            <div className="pane-body">
                {usage.isPending && <div className="empty">Loading…</div>}
                {usage.isError && <div className="empty">{(usage.error as Error).message}</div>}
                {stats && (
                    <>
                        <div className="stat-grid">
                            <div className="stat-card">
                                <div className="stat-label">AI calls</div>
                                <div className="stat-value">{stats.totals.calls.toLocaleString()}</div>
                                <div className="stat-sub">last {stats.days} days</div>
                            </div>
                            <div className="stat-card">
                                <div className="stat-label">Input tokens</div>
                                <div className="stat-value">{formatTokens(stats.totals.inputTokens)}</div>
                                <div className="stat-sub">{stats.totals.inputTokens.toLocaleString()}</div>
                            </div>
                            <div className="stat-card">
                                <div className="stat-label">Output tokens</div>
                                <div className="stat-value">{formatTokens(stats.totals.outputTokens)}</div>
                                <div className="stat-sub">{stats.totals.outputTokens.toLocaleString()}</div>
                            </div>
                            <div className="stat-card">
                                <div className="stat-label">Total tokens</div>
                                <div className="stat-value">{formatTokens(total)}</div>
                                <div className="stat-sub">{total.toLocaleString()}</div>
                            </div>
                        </div>
                        {total === 0 && stats.totals.calls === 0 ? (
                            <div className="empty">No AI usage recorded in this window — go chat with Goobster!</div>
                        ) : (
                            <>
                                <div className="section-title">Tokens per day</div>
                                <div className="list-card usage-chart-card">
                                    <canvas
                                        ref={canvasRef}
                                        className="usage-chart"
                                        role="img"
                                        aria-label="Bar chart of daily token usage"
                                    />
                                    <div className="hint usage-legend">
                                        <span className="key"><span className="dot" style={{ background: 'var(--accent)' }} /> input</span>
                                        <span className="key"><span className="dot" style={{ background: 'var(--ok)' }} /> output</span>
                                    </div>
                                </div>
                                {stats.byModel.length > 0 && (
                                    <>
                                        <div className="section-title">By model</div>
                                        <div className="list-card">
                                            {stats.byModel.map((row) => (
                                                <div key={`${row.provider}:${row.model}`} className="list-row">
                                                    <div className="row-body">
                                                        <span className="badge">{row.provider}</span>
                                                        <code>{row.model}</code>
                                                        <div className="row-meta">
                                                            {row.calls.toLocaleString()} call{row.calls === 1 ? '' : 's'}
                                                        </div>
                                                    </div>
                                                    <div className="usage-numbers">
                                                        <span title="input tokens">↑ {formatTokens(row.inputTokens)}</span>
                                                        <span title="output tokens">↓ {formatTokens(row.outputTokens)}</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                                {stats.byOperation.length > 0 && (
                                    <>
                                        <div className="section-title">By operation</div>
                                        <div className="list-card">
                                            {stats.byOperation.map((row) => (
                                                <div key={row.operation} className="list-row">
                                                    <div className="row-body">
                                                        {row.operation}
                                                        <div className="row-meta">
                                                            {row.calls.toLocaleString()} call{row.calls === 1 ? '' : 's'}
                                                        </div>
                                                    </div>
                                                    <div className="usage-numbers">
                                                        <span>{formatTokens(row.totalTokens || 0)} tokens</span>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    </>
                                )}
                                <div className="hint" style={{ marginTop: 10 }}>
                                    Your personal usage across every surface (web, DMs, servers).
                                    Token counts come straight from the providers; prices vary by plan, so no cost estimates are shown.
                                </div>
                            </>
                        )}
                    </>
                )}
            </div>
        </main>
    );
}
