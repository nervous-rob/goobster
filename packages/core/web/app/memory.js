/**
 * Memory dashboard pane: per-scope transparency report, facts and memories
 * with delete controls, and the knowledge-graph view.
 */
import { api } from './api.js';
import { GraphView, TYPE_COLORS } from './graph.js';

const scopeSelect = document.getElementById('scope-select');
const tabs = document.getElementById('memory-tabs');
const graphTabBtn = document.getElementById('graph-tab-btn');
const panes = {
    map: document.getElementById('mtab-map'),
    overview: document.getElementById('mtab-overview'),
    facts: document.getElementById('mtab-facts'),
    memories: document.getElementById('mtab-memories'),
    graph: document.getElementById('mtab-graph')
};

let scopes = [];
let currentScope = null;
let currentTab = 'map';
let graphView = null;
let constellationView = null;
let showToast = () => {};
let confirmDialog = async () => false;
let openForget = () => {};
let initialized = false;

function scopeById(id) {
    return scopes.find(s => s.id === id) || null;
}

function el(html) {
    const template = document.createElement('template');
    template.innerHTML = html.trim();
    return template.content.firstElementChild;
}

function whenLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

/* ---------- overview ---------- */

function statCard(label, value, sub = '') {
    return `
      <div class="stat-card">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${value}</div>
        ${sub ? `<div class="stat-sub">${sub}</div>` : ''}
      </div>`;
}

async function renderOverview() {
    panes.overview.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const report = await api.report(currentScope);
        const memorySub = report.memories.count > 0
            ? `${whenLabel(report.memories.oldest)} &rarr; ${whenLabel(report.memories.newest)}`
            : 'nothing stored';

        panes.overview.innerHTML = `
          <div class="stat-grid privacy-cards">
            ${statCard('Facts about you', report.facts.length)}
            ${statCard('Memories', report.memories.count, memorySub)}
            ${statCard('Chat messages', report.conversations.messages, `${report.conversations.count} conversation${report.conversations.count === 1 ? '' : 's'} (bot-wide)`)}
            ${statCard('Pending follow-ups', report.followups.length)}
            ${statCard('Pinned applets', report.applets || 0)}
            ${statCard('AI calls', report.usageRows)}
            ${statCard('Messages counted', report.activityMessages, 'activity counters, no content')}
            ${report.economy.balance !== null ? statCard('Wallet', report.economy.balance, `${report.economy.transactions} ledger entries`) : ''}
            ${report.nickname ? statCard('Nickname', report.nickname) : ''}
          </div>
          <div class="privacy-stage">
            <p class="hint">This is the same data <code>/what-do-you-know-about-me</code> reports in Discord.
            Delete individual facts and memories on their tabs, or erase everything here.</p>
            <button type="button" class="btn danger" id="library-forget-btn">Forget me — watch it disappear</button>
          </div>
        `;
        panes.overview.querySelector('#library-forget-btn')?.addEventListener('click', () => openForget());

        if (report.followups.length > 0) {
            const list = el('<div class="list-card"></div>');
            for (const followup of report.followups) {
                list.appendChild(el(`
                  <div class="list-row">
                    <div class="row-body">${escapeText(followup.note)}
                      <div class="row-meta">due ${followup.dueAt} UTC</div>
                    </div>
                  </div>`));
            }
            panes.overview.appendChild(el('<div class="section-title">Pending follow-ups</div>'));
            panes.overview.appendChild(list);
        }

        // DM scope only: the memory auto-delete window (guild retention
        // stays a Manage Server action via /privacy in Discord).
        if (scopeById(currentScope)?.kind === 'dm') {
            await renderRetentionCard();
        }
    } catch (error) {
        panes.overview.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    }
}

/* ---------- memory retention (DM scope) ---------- */

const RETENTION_OPTIONS = [
    { value: 0, label: 'Keep forever' },
    { value: 7, label: 'After 7 days' },
    { value: 30, label: 'After 30 days' },
    { value: 90, label: 'After 90 days' },
    { value: 180, label: 'After 180 days' },
    { value: 365, label: 'After a year' }
];

async function renderRetentionCard() {
    let current;
    try {
        current = await api.retention(currentScope);
    } catch {
        return; // older server without the route - just skip the card
    }

    const card = el(`
      <div class="list-card retention-card">
        <div class="list-row">
          <div class="row-body">
            <strong>Auto-delete memories</strong>
            <div class="row-meta">Raw memories from your DMs and web chats older than this window are
            deleted automatically (immediately, then nightly). Distilled facts are separate - manage them in the Facts tab.</div>
          </div>
          <select class="select retention-select" aria-label="Memory auto-delete window"></select>
        </div>
      </div>`);
    const select = card.querySelector('select');
    const options = [...RETENTION_OPTIONS];
    const days = current.retentionDays ?? 0;
    if (days && !options.some(o => o.value === days)) {
        options.push({ value: days, label: `After ${days} days` });
        options.sort((a, b) => (a.value || Infinity) - (b.value || Infinity));
    }
    select.replaceChildren(...options.map(option =>
        Object.assign(document.createElement('option'), {
            value: String(option.value), textContent: option.label
        })
    ));
    select.value = String(days);

    select.addEventListener('change', async () => {
        const chosen = Number(select.value);
        if (chosen > 0 && !await confirmDialog(
            `Auto-delete memories older than ${chosen} days? Anything already past that window is deleted right now.`)) {
            select.value = String(days);
            return;
        }
        select.disabled = true;
        try {
            const result = await api.setRetention(currentScope, chosen);
            showToast(result.retentionDays
                ? `Memories now expire after ${result.retentionDays} days${result.purged ? ` - ${result.purged} deleted now` : ''}.`
                : 'Memories are kept forever again.');
            renderOverview();
        } catch (error) {
            showToast(error.message, true);
            select.disabled = false;
        }
    });

    panes.overview.appendChild(el('<div class="section-title">Memory retention</div>'));
    panes.overview.appendChild(card);
}

function escapeText(text) {
    const span = document.createElement('span');
    span.textContent = String(text ?? '');
    return span.innerHTML;
}

/* ---------- facts ---------- */

async function renderFacts() {
    panes.facts.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const { facts } = await api.facts(currentScope);
        if (facts.length === 0) {
            panes.facts.innerHTML = '<div class="empty">No distilled facts here yet.</div>';
            return;
        }
        const list = el('<div class="list-card"></div>');
        for (const fact of facts) {
            const row = el(`
              <div class="list-row">
                <div class="row-body">
                  <span class="badge">${fact.subjectType === 'GUILD' ? 'shared' : 'you'}</span>${escapeText(fact.content)}
                  <div class="row-meta">${escapeText(fact.source)} &middot; ${whenLabel(fact.updatedAt)}</div>
                </div>
                <button class="row-delete" title="Forget this fact">✕</button>
              </div>`);
            row.querySelector('.row-delete').addEventListener('click', async () => {
                if (!await confirmDialog('Forget this fact? Goobster will no longer know it.')) return;
                try {
                    await api.deleteFact(currentScope, fact.id);
                    row.remove();
                    showToast('Fact forgotten.');
                } catch (error) {
                    showToast(error.message, true);
                }
            });
            list.appendChild(row);
        }
        panes.facts.replaceChildren(
            el(`<div class="hint" style="margin-bottom:10px">Distilled notes in your knowledge graph about ${scopeById(currentScope)?.kind === 'dm' ? 'your DMs' : 'you in this server'}. Connected notes and relationships appear on the Map tab.</div>`),
            list
        );
    } catch (error) {
        panes.facts.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    }
}

/* ---------- memories ---------- */

async function renderMemories() {
    panes.memories.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const { memories } = await api.memories(currentScope);
        if (memories.length === 0) {
            panes.memories.innerHTML = '<div class="empty">No stored memories here.</div>';
            return;
        }
        const list = el('<div class="list-card"></div>');
        for (const memory of memories) {
            const row = el(`
              <div class="list-row">
                <div class="row-body">${escapeText(memory.content)}
                  <div class="row-meta">${escapeText(memory.authorName || 'unknown')} &middot; ${whenLabel(memory.createdAt)}</div>
                </div>
                <button class="row-delete" title="Delete this memory">✕</button>
              </div>`);
            row.querySelector('.row-delete').addEventListener('click', async () => {
                if (!await confirmDialog('Delete this memory? It cannot be recalled afterwards.')) return;
                try {
                    await api.deleteMemory(currentScope, memory.id);
                    row.remove();
                    showToast('Memory deleted.');
                } catch (error) {
                    showToast(error.message, true);
                }
            });
            list.appendChild(row);
        }
        const scope = scopeById(currentScope);
        panes.memories.replaceChildren(
            el(`<div class="hint" style="margin-bottom:10px">${
                scope?.kind === 'dm'
                    ? 'Everything remembered from your DMs and web chat (both sides of the conversation).'
                    : 'Memories you authored in this server. Other members\u2019 memories are theirs to manage.'
            }</div>`),
            list
        );
    } catch (error) {
        panes.memories.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    }
}

/* ---------- reflection (the Reflect button) ---------- */

function reflectionTotal(run, field) {
    let total = 0;
    for (const pass of Object.values(run?.summary || {})) {
        if (typeof pass?.[field] === 'number') total += pass[field];
    }
    return total;
}

function describeReflection(run) {
    const parts = [];
    const distilled = reflectionTotal(run, 'memoriesDistilled');
    const notes = reflectionTotal(run, 'nodesUpserted');
    const links = reflectionTotal(run, 'linksCreated');
    const merged = reflectionTotal(run, 'nodesMerged');
    const pruned = reflectionTotal(run, 'nodesPruned') + reflectionTotal(run, 'edgesPruned');
    if (distilled > 0) parts.push(`${distilled} memories distilled`);
    if (notes > 0) parts.push(`${notes} note${notes === 1 ? '' : 's'} updated`);
    if (links > 0) parts.push(`${links} connection${links === 1 ? '' : 's'} woven`);
    if (merged > 0) parts.push(`${merged} merged`);
    if (pruned > 0) parts.push(`${pruned} pruned`);
    return parts.length > 0 ? parts.join(' · ') : 'nothing new — the graph is already tidy';
}

/**
 * A Reflect button for a graph legend: starts a knowledge-enrichment run
 * (distill + weave + tidy) and polls the run until it settles, then
 * refreshes the pane. One poll loop per scope+target.
 */
function reflectControl(target) {
    const scope = currentScope;
    const control = el('<span class="key reflect-control"></span>');
    const button = el('<button type="button" class="btn small" title="Distill fresh memories and weave semantic relationships in this graph">✦ Reflect</button>');
    control.appendChild(button);

    const setRunning = (running) => {
        button.disabled = running;
        button.textContent = running ? 'Reflecting…' : '✦ Reflect';
    };

    const poll = async (announce) => {
        let run;
        try {
            run = (await api.reflection(scope, target)).run;
        } catch {
            setRunning(false);
            return;
        }
        if (scope !== currentScope) return; // scope changed while polling
        if (run?.status === 'running') {
            setRunning(true);
            setTimeout(() => poll(announce), 2000);
            return;
        }
        setRunning(false);
        if (announce && run) {
            if (run.status === 'completed') {
                showToast(`Reflection complete — ${describeReflection(run)}.`);
            } else {
                showToast(run.error || 'Reflection failed.', true);
            }
            refresh();
        }
    };

    button.addEventListener('click', async () => {
        setRunning(true);
        try {
            await api.startReflection(scope, target);
            poll(true);
        } catch (error) {
            setRunning(false);
            showToast(error.message, true);
        }
    });

    poll(false); // reflect current state (a run may already be in flight)
    return control;
}

/* ---------- personal constellation ---------- */

function renderConstellationDetail(node) {
    const detail = document.getElementById('constellation-detail');
    if (!node) {
        detail.classList.add('hidden');
        return;
    }
    const tags = (node.tags || []).map(t => `<span class="tag-chip">${escapeText(t)}</span>`).join(' ');
    const provenance = (node.provenance || [])
        .slice(0, 4)
        .map(p => {
            const source = p.sourceKind === 'memory' && p.sourceId
                ? `${p.sourceKind} #${p.sourceId}`
                : p.sourceKind;
            return `<span class="tag-chip">${escapeText(source)}</span>`;
        })
        .join(' ');
    detail.classList.remove('hidden');
    detail.innerHTML = `
      <div class="gd-type">${escapeText(node.type)}${node.confidence != null ? ` · confidence ${Number(node.confidence).toFixed(2)}` : ''}${node.source ? ` · ${escapeText(node.source)}` : ''}</div>
      <div class="gd-label">${escapeText(node.label)}</div>
      ${node.content ? `<div class="gd-content">${escapeText(node.content)}</div>` : ''}
      ${tags ? `<div class="gd-tags">${tags}</div>` : ''}
      ${provenance ? `<div class="gd-tags"><span class="hint">sources:</span> ${provenance}</div>` : ''}
    `;
}

async function renderConstellation() {
    const emptyEl = document.getElementById('constellation-empty');
    const legend = document.getElementById('constellation-legend');
    emptyEl.classList.add('hidden');
    renderConstellationDetail(null);

    try {
        const { nodes, edges, counts } = await api.constellation(currentScope);
        legend.replaceChildren(
            el('<span class="key"><span class="dot" style="background:#54c2ff"></span>you</span>'),
            el('<span class="key"><span class="dot" style="background:#59d18c"></span>notes</span>'),
            el('<span class="key"><span class="dot" style="background:#7c8cff"></span>edges</span>'),
            el(`<span class="key">${(counts?.nodes || 0)} notes · ${(counts?.edges || 0)} links · ${(counts?.memories || 0)} raw memories</span>`),
            reflectControl('personal')
        );
        if (!constellationView) {
            constellationView = new GraphView(document.getElementById('constellation-canvas'), {
                onSelect: renderConstellationDetail
            });
        }
        constellationView.setData({ nodes, edges });
        if (nodes.length <= 1) emptyEl.classList.remove('hidden');
    } catch (error) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = error.message;
    }
}

/* ---------- knowledge graph ---------- */

function renderGraphDetail(node) {
    const detail = document.getElementById('graph-detail');
    if (!node) {
        detail.classList.add('hidden');
        return;
    }
    detail.classList.remove('hidden');
    detail.innerHTML = `
      <div class="gd-type">${escapeText(node.type)} &middot; salience ${(node.salience ?? 0).toFixed(2)}${node.confidence != null ? ` · confidence ${Number(node.confidence).toFixed(2)}` : ''}</div>
      <div class="gd-label">${escapeText(node.label)}</div>
      ${node.content ? `<div class="gd-content">${escapeText(node.content)}</div>` : ''}
    `;
}

async function renderGraph() {
    const emptyEl = document.getElementById('graph-empty');
    const legend = document.getElementById('graph-legend');
    const innerLife = document.getElementById('inner-life');
    emptyEl.classList.add('hidden');
    renderGraphDetail(null);

    try {
        const { nodes, edges, thoughts, scratchpad } = await api.graph(currentScope);

        legend.replaceChildren(
            ...Object.entries(TYPE_COLORS).map(([type, color]) =>
                el(`<span class="key"><span class="dot" style="background:${color}"></span>${type}</span>`)),
            reflectControl('guild')
        );

        if (!graphView) {
            graphView = new GraphView(document.getElementById('graph-canvas'), {
                onSelect: renderGraphDetail
            });
        }
        graphView.setData({ nodes, edges });
        if (nodes.length === 0) emptyEl.classList.remove('hidden');

        const thoughtItems = (thoughts || []).map(t =>
            `<li>${escapeText(t.thought)} <span class="when">${whenLabel(t.createdAt)}</span></li>`).join('');
        const padItems = (scratchpad || []).map(n => `<li>${escapeText(n.content)}</li>`).join('');
        innerLife.innerHTML = `
          <div class="inner-card">
            <div class="inner-title">Recent private thoughts</div>
            ${thoughtItems ? `<ul>${thoughtItems}</ul>` : '<div class="hint">Nothing yet.</div>'}
          </div>
          <div class="inner-card">
            <div class="inner-title">Scratch pad</div>
            ${padItems ? `<ul>${padItems}</ul>` : '<div class="hint">Empty.</div>'}
          </div>`;
    } catch (error) {
        emptyEl.classList.remove('hidden');
        emptyEl.textContent = error.message;
        innerLife.innerHTML = '';
    }
}

/* ---------- wiring ---------- */

function setTab(tab) {
    currentTab = tab;
    for (const btn of tabs.querySelectorAll('.segment-btn')) {
        btn.classList.toggle('active', btn.dataset.mtab === tab);
    }
    for (const [name, pane] of Object.entries(panes)) {
        pane.classList.toggle('hidden', name !== tab);
    }
    if (tab !== 'graph') graphView?.stop();
    if (tab !== 'map') constellationView?.stop();
    refresh();
}

function refresh() {
    if (!currentScope) return;
    if (currentTab === 'map') renderConstellation();
    else if (currentTab === 'overview') renderOverview();
    else if (currentTab === 'facts') renderFacts();
    else if (currentTab === 'memories') renderMemories();
    else if (currentTab === 'graph') renderGraph();
}

function onScopeChange() {
    currentScope = scopeSelect.value;
    const scope = scopeById(currentScope);
    const graphAllowed = Boolean(scope?.graphAvailable);
    graphTabBtn.classList.toggle('hidden', !graphAllowed);
    if (!graphAllowed && currentTab === 'graph') {
        setTab('map');
        return;
    }
    refresh();
}

/**
 * Prepare the dashboard (idempotent; refreshes on every visit).
 * @param {Object} params - { me, toast, confirm }
 */
export function initMemory({ me, toast, confirm, forget = () => {} }) {
    showToast = toast;
    confirmDialog = confirm;
    openForget = forget;
    scopes = me.scopes || [];

    scopeSelect.replaceChildren(...scopes.map(scope => {
        const option = document.createElement('option');
        option.value = scope.id;
        option.textContent = scope.kind === 'dm' ? `🔒 ${scope.name}` : scope.name;
        return option;
    }));

    if (!initialized) {
        initialized = true;
        scopeSelect.addEventListener('change', onScopeChange);
        tabs.addEventListener('click', (event) => {
            const btn = event.target.closest('.segment-btn');
            if (btn) setTab(btn.dataset.mtab);
        });
    }

    if (!currentScope || !scopeById(currentScope)) {
        currentScope = scopes[0]?.id || null;
    }
    scopeSelect.value = currentScope;
    onScopeChange();
}
