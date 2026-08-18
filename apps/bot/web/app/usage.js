/**
 * Personal usage dashboard: the user's own AI calls and token volume from
 * usage_log, with a dependency-free canvas bar chart. Token counts only -
 * the server records no prices, so none are invented here.
 */
import { api } from './api.js';

const content = document.getElementById('usage-content');
const periodSegment = document.getElementById('usage-period');

let showToast = () => {};
let wired = false;
let days = 30;

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function escapeText(text) {
    const span = document.createElement('span');
    span.textContent = String(text ?? '');
    return span.innerHTML;
}

function formatTokens(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 10_000) return `${Math.round(n / 1000)}k`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

function statCard(label, value, sub = '') {
    return `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
      </div>`;
}

/** Fill the window with a contiguous day series so quiet days show as gaps. */
function daySeries(byDay, windowDays) {
    const byKey = new Map(byDay.map(d => [d.day, d]));
    const series = [];
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

function drawChart(canvas, series) {
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
    ctx.scale(dpr, dpr);

    const pad = { left: 44, right: 8, top: 10, bottom: 22 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const max = Math.max(1, ...series.map(d => d.inputTokens + d.outputTokens));

    // Gridlines + y labels
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

    // Stacked bars: input tokens below, output tokens on top
    const step = plotW / series.length;
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

    // X labels (bounded count so they never collide)
    ctx.fillStyle = colors.text;
    const every = Math.ceil(series.length / Math.floor(plotW / 46));
    series.forEach((d, i) => {
        if (i % every !== 0 && i !== series.length - 1) return;
        const x = pad.left + step * i + step / 2;
        ctx.textAlign = 'center';
        ctx.fillText(d.label, x, height - 6);
    });
}

async function refresh() {
    content.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const stats = await api.usage(days);
        const total = stats.totals.inputTokens + stats.totals.outputTokens;

        content.replaceChildren(el(`
          <div>
            <div class="stat-grid">
              ${statCard('AI calls', stats.totals.calls.toLocaleString(), `last ${stats.days} days`)}
              ${statCard('Input tokens', formatTokens(stats.totals.inputTokens), stats.totals.inputTokens.toLocaleString())}
              ${statCard('Output tokens', formatTokens(stats.totals.outputTokens), stats.totals.outputTokens.toLocaleString())}
              ${statCard('Total tokens', formatTokens(total), total.toLocaleString())}
            </div>
          </div>`));

        if (total === 0 && stats.totals.calls === 0) {
            content.appendChild(el('<div class="empty">No AI usage recorded in this window - go chat with Goobster!</div>'));
            return;
        }

        // Daily chart
        content.appendChild(el('<div class="section-title">Tokens per day</div>'));
        const chartCard = el(`
          <div class="list-card usage-chart-card">
            <canvas class="usage-chart" role="img" aria-label="Bar chart of daily token usage"></canvas>
            <div class="hint usage-legend">
              <span class="key"><span class="dot" style="background:var(--accent)"></span> input</span>
              <span class="key"><span class="dot" style="background:var(--ok)"></span> output</span>
            </div>
          </div>`);
        content.appendChild(chartCard);
        const canvas = chartCard.querySelector('canvas');
        requestAnimationFrame(() => drawChart(canvas, daySeries(stats.byDay, stats.days)));

        // Per-model table
        if (stats.byModel.length > 0) {
            content.appendChild(el('<div class="section-title">By model</div>'));
            const list = el('<div class="list-card"></div>');
            for (const row of stats.byModel) {
                list.appendChild(el(`
                  <div class="list-row">
                    <div class="row-body">
                      <span class="badge">${escapeText(row.provider)}</span><code>${escapeText(row.model)}</code>
                      <div class="row-meta">${row.calls.toLocaleString()} call${row.calls === 1 ? '' : 's'}</div>
                    </div>
                    <div class="usage-numbers">
                      <span title="input tokens">↑ ${formatTokens(row.inputTokens)}</span>
                      <span title="output tokens">↓ ${formatTokens(row.outputTokens)}</span>
                    </div>
                  </div>`));
            }
            content.appendChild(list);
        }

        // Per-operation breakdown
        if (stats.byOperation.length > 0) {
            content.appendChild(el('<div class="section-title">By operation</div>'));
            const list = el('<div class="list-card"></div>');
            for (const row of stats.byOperation) {
                list.appendChild(el(`
                  <div class="list-row">
                    <div class="row-body">${escapeText(row.operation)}
                      <div class="row-meta">${row.calls.toLocaleString()} call${row.calls === 1 ? '' : 's'}</div>
                    </div>
                    <div class="usage-numbers"><span>${formatTokens(row.totalTokens || 0)} tokens</span></div>
                  </div>`));
            }
            content.appendChild(list);
        }

        content.appendChild(el(
            '<div class="hint" style="margin-top:10px">Your personal usage across every surface (web, DMs, servers). ' +
            'Token counts come straight from the providers; prices vary by plan, so no cost estimates are shown.</div>'
        ));
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        showToast(error.message, true);
    }
}

/**
 * Prepare the usage pane (idempotent; refreshes on every visit).
 * @param {Object} params - { me, toast }
 */
export function initUsage({ toast }) {
    showToast = toast;

    if (!wired) {
        wired = true;
        periodSegment.addEventListener('click', (event) => {
            const btn = event.target.closest('.segment-btn');
            if (!btn) return;
            days = Number(btn.dataset.days) || 30;
            for (const other of periodSegment.querySelectorAll('.segment-btn')) {
                other.classList.toggle('active', other === btn);
            }
            refresh();
        });
    }

    refresh();
}
