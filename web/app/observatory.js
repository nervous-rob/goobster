/**
 * Observatory pane: persistent simulation projects and their background
 * jobs, master-detail style. The list view shows every project at a
 * glance; opening one shows THE standardized project view - status chips,
 * quota, latest render, jobs with output tails, checkpoint, gallery, and
 * files - the same facts as the shareable snapshot page, but live.
 *
 * The ✨ Command button prompts Goobster (a full agent turn with the
 * `observatory` tool) to continue the open project - or, from the list
 * view, to act across the whole Observatory - and streams the agent's
 * progress right here in the pane.
 */
import { api, streamObservatoryCommand } from './api.js';
import { renderMarkdown } from './markdown.js';
import { openModal, closeModal } from './modal.js';

const pane = document.getElementById('pane-observatory');
const content = document.getElementById('observatory-content');
const titleEl = document.getElementById('observatory-title');
const backBtn = document.getElementById('observatory-back');
const commandBtn = document.getElementById('observatory-command-btn');
const refreshBtn = document.getElementById('observatory-refresh-btn');
const commandBackdrop = document.getElementById('observatory-command-backdrop');
const commandTitle = document.getElementById('observatory-command-title');
const commandScope = document.getElementById('observatory-command-scope');
const commandInput = document.getElementById('observatory-command-input');
const commandRunBtn = document.getElementById('observatory-command-run');

let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;

/** 'list' or 'detail' - which subview the pane is showing. */
let view = 'list';
let openProject = null; // { slug, name } while the detail view is open
let lastListPrint = null;
let lastDetailPrint = null;
let detailHasRunning = false;
let pollTimer = null;

/** The in-flight (or last finished) custom command, rendered up top. */
let command = null; // { active, label, strip, reply, error }
let commandArea = null;
let viewArea = null;

const POLL_MS = 5000;

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

function whenLabel(utcText) {
    if (!utcText) return '';
    const date = new Date(utcText.includes('T') ? utcText : `${utcText.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return utcText;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function sizeLabel(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

const STATUS_ICONS = {
    RUNNING: '🟢', COMPLETED: '✅', FAILED: '❌',
    TIMED_OUT: '⏱️', CANCELLED: '⏹️', INTERRUPTED: '💤'
};

/* ---------- the list view (all projects) ---------- */

function projectCard(project) {
    const card = el(`
      <div class="list-row task-row obs-project-card" role="button" tabindex="0">
        <div class="row-body">
          <strong>🔭 ${escapeText(project.name)}</strong>
          <span class="badge">${escapeText(project.slug)}</span>
          ${project.shared ? '<span class="badge">🔗 shared</span>' : ''}
          <div class="row-meta">
            ${project.runningJobs > 0 ? `🟢 ${project.runningJobs} running · ` : ''}${project.totalJobs} job(s)
            · ${project.sizeMb}/${project.quotaMb} MB
            · updated ${whenLabel(project.updatedAt)}
          </div>
        </div>
        <span class="obs-chevron" aria-hidden="true">›</span>
      </div>`);
    const open = () => showDetail(project);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            open();
        }
    });
    return card;
}

async function renderList({ silent = false } = {}) {
    if (!silent) viewArea.innerHTML = '<div class="empty">Loading&hellip;</div>';
    let projects;
    try {
        ({ projects } = await api.observatoryProjects());
    } catch (error) {
        if (!silent) viewArea.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }
    const print = JSON.stringify(projects);
    if (silent && print === lastListPrint) return;
    lastListPrint = print;
    viewArea.replaceChildren();

    if (projects.length === 0) {
        const empty = el(`
          <div class="empty-state" style="margin-top:6vh">
            <div class="empty-logo">🔭</div>
            <div class="empty-title">No projects yet</div>
            <div class="hint" style="max-width:460px;margin:0 auto 18px">
              Observatory projects are persistent workspaces for long-running simulations.
              Checkpointed jobs keep running while you're away, frames become videos
              automatically, and everything lands here. Ask for one in chat, or command
              Goobster directly:
            </div>
            <button class="btn primary big">✨ Give Goobster instructions</button>
          </div>`);
        empty.querySelector('button').addEventListener('click', openCommandModal);
        viewArea.appendChild(empty);
        return;
    }

    viewArea.appendChild(el('<div class="section-title">Projects</div>'));
    const list = el('<div class="list-card"></div>');
    for (const project of projects) list.appendChild(projectCard(project));
    viewArea.appendChild(list);
    viewArea.appendChild(el(
        '<div class="hint" style="margin-top:10px">Open a project to watch its jobs, renders, and files '
        + 'live - and to render, share, or ✨ command Goobster to continue it. Background jobs notify '
        + 'you in your Discord DMs when they finish.</div>'
    ));
}

/* ---------- the detail view (one project, standardized) ---------- */

function jobRow(job) {
    const meta = [
        escapeText(job.language),
        `${job.segments} segment(s)`,
        `${job.resumeCount} resume(s)`,
        job.exitCode !== null && job.exitCode !== undefined ? `exit ${job.exitCode}` : null,
        job.checkpointAt ? `checkpoint ${whenLabel(job.checkpointAt)}` : null,
        job.finishedAt ? `finished ${whenLabel(job.finishedAt)}` : `heartbeat ${whenLabel(job.lastHeartbeatAt)}`
    ].filter(Boolean).join(' · ');
    const row = el(`
      <div class="list-row task-row">
        <div class="row-body">
          <span class="badge">${STATUS_ICONS[job.status] || ''} ${escapeText(job.status)}</span>
          <strong>Job #${job.id}</strong>
          <div class="row-meta">${meta}</div>
          ${job.error ? `<div class="row-meta obs-error">${escapeText(job.error)}</div>` : ''}
          ${job.stdoutTail?.trim()
        ? `<details class="obs-tail"><summary>stdout tail</summary><pre>${escapeText(job.stdoutTail)}</pre></details>` : ''}
          ${job.stderrTail?.trim() && job.status !== 'COMPLETED'
        ? `<details class="obs-tail"><summary>stderr tail</summary><pre>${escapeText(job.stderrTail)}</pre></details>` : ''}
        </div>
      </div>`);
    if (job.status === 'RUNNING') {
        const btn = el('<button class="btn danger">Cancel</button>');
        btn.addEventListener('click', async () => {
            if (!await confirmDialog(`Cancel job #${job.id}?`)) return;
            try {
                await api.observatoryCancelJob(job.id);
                showToast(`Job #${job.id} cancelled.`);
                renderDetail();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        row.appendChild(btn);
    } else if (job.status === 'INTERRUPTED' || job.status === 'TIMED_OUT') {
        const btn = el('<button class="btn">▶ Resume</button>');
        btn.addEventListener('click', async () => {
            try {
                await api.observatoryResumeJob(job.id);
                showToast(`Job #${job.id} resumed.`);
                renderDetail();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        row.appendChild(btn);
    }
    return row;
}

/** Stable content signature - polling skips re-renders when nothing moved. */
function detailPrint(detail) {
    return JSON.stringify({
        p: detail.project,
        j: detail.jobs.map(j => [j.id, j.status, j.segments, j.resumeCount,
            (j.stdoutTail || '').length, (j.stderrTail || '').length]),
        f: detail.files.map(f => [f.path, f.size]),
        c: detail.checkpoint
    });
}

function detailActions(detail) {
    const { slug, name, shared } = { ...detail.project };
    const row = el('<div class="obs-actions"></div>');

    const renderBtn = el('<button class="btn" title="Stitch the project\'s frames into a video now">🎬 Render video</button>');
    renderBtn.addEventListener('click', async () => {
        renderBtn.disabled = true;
        try {
            const result = await api.observatoryRender(slug);
            showToast(`Rendered ${result.frames} frame(s) at ${result.fps} fps.`);
            renderDetail();
        } catch (error) {
            showToast(error.message, true);
        } finally {
            renderBtn.disabled = false;
        }
    });
    row.appendChild(renderBtn);

    row.appendChild(el(
        `<a class="btn" target="_blank" rel="noopener"
           title="A self-contained snapshot page of these results - downloadable, and what a share link shows"
           href="/api/app/observatory/projects/${encodeURIComponent(slug)}/dashboard">📸 Snapshot page</a>`));

    const shareBtn = el(`<button class="btn" title="Share a read-only snapshot link"
        aria-pressed="${shared ? 'true' : 'false'}">${shared ? '🔗 Shared' : '🔗 Share'}</button>`);
    shareBtn.addEventListener('click', async () => {
        try {
            const status = await api.observatoryShareStatus(slug);
            if (!status.shared) {
                const created = await api.observatoryCreateShare(slug);
                const url = new URL(created.url, window.location.origin).href;
                try { await navigator.clipboard.writeText(url); } catch { /* clipboard denied */ }
                shareBtn.textContent = '🔗 Shared';
                shareBtn.setAttribute('aria-pressed', 'true');
                showToast(`Share link copied: ${url}`);
            } else if (await confirmDialog('Revoke the share link? The URL stops working immediately.')) {
                await api.observatoryRevokeShare(slug);
                shareBtn.textContent = '🔗 Share';
                shareBtn.setAttribute('aria-pressed', 'false');
                showToast('Share link revoked.');
            } else {
                const url = new URL(status.url, window.location.origin).href;
                try { await navigator.clipboard.writeText(url); } catch { /* clipboard denied */ }
                showToast(`Still shared - link copied: ${url}`);
            }
        } catch (error) {
            showToast(error.message, true);
        }
    });
    row.appendChild(shareBtn);

    const deleteBtn = el('<button class="btn danger" title="Delete the project and its whole workspace">✕ Delete</button>');
    deleteBtn.addEventListener('click', async () => {
        if (!await confirmDialog(
            `Delete "${name}" and its whole workspace? Files and job history are gone for good.`)) return;
        try {
            await api.observatoryDeleteProject(slug);
            showToast('Project deleted.');
            showList();
        } catch (error) {
            showToast(error.message, true);
        }
    });
    row.appendChild(deleteBtn);
    return row;
}

async function renderDetail(slugOverride = null, { silent = false } = {}) {
    const slug = slugOverride || openProject?.slug;
    if (!slug) return;
    if (!silent) viewArea.innerHTML = '<div class="empty">Loading&hellip;</div>';
    let detail;
    try {
        detail = await api.observatoryProject(slug);
    } catch (error) {
        if (error.status === 404) {
            // Deleted (possibly by a command) - fall back to the list
            showList();
            return;
        }
        if (!silent) viewArea.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }
    detailHasRunning = detail.project.runningJobs > 0;
    const print = detailPrint(detail);
    if (silent && print === lastDetailPrint) return;
    lastDetailPrint = print;

    openProject = { slug: detail.project.slug, name: detail.project.name };
    titleEl.textContent = `🔭 ${detail.project.name}`;
    viewArea.replaceChildren();

    // Overview: status chips + the quota bar
    const p = detail.project;
    const completed = detail.jobs.filter(j => j.status === 'COMPLETED').length;
    const failed = detail.jobs.filter(j => j.status === 'FAILED' || j.status === 'TIMED_OUT').length;
    const quotaPct = Math.min(100, Math.round((p.sizeMb / p.quotaMb) * 100));
    viewArea.appendChild(el(`
      <div class="obs-chips">
        ${p.runningJobs > 0 ? `<span class="obs-chip">🟢 Running <b>${p.runningJobs}</b></span>` : ''}
        <span class="obs-chip">Jobs <b>${p.totalJobs}</b></span>
        <span class="obs-chip">✅ Completed <b>${completed}</b></span>
        ${failed > 0 ? `<span class="obs-chip">❌ Failed <b>${failed}</b></span>` : ''}
        <span class="obs-chip">Workspace <b>${p.sizeMb} / ${p.quotaMb} MB</b></span>
        <span class="obs-chip">Updated <b>${whenLabel(p.updatedAt)}</b></span>
      </div>`));
    viewArea.appendChild(el(
        `<div class="obs-quota" role="img" aria-label="Disk quota ${quotaPct}% used">
           <i style="width:${quotaPct}%"></i></div>`));

    viewArea.appendChild(detailActions(detail));

    // Latest render, playable inline
    const videos = detail.files.filter(f => f.isVideo && f.url);
    if (videos.length > 0) {
        viewArea.appendChild(el('<div class="section-title">Latest render</div>'));
        viewArea.appendChild(el(
            `<video class="obs-video" src="${videos[0].url}" controls preload="metadata"></video>`));
        viewArea.appendChild(el(`<div class="row-meta">${escapeText(videos[0].path)}${videos.length > 1
            ? ` · ${videos.length - 1} earlier render(s) in the files below` : ''}</div>`));
    }

    // Jobs, newest first, with their output tails
    viewArea.appendChild(el('<div class="section-title">Jobs</div>'));
    if (detail.jobs.length === 0) {
        viewArea.appendChild(el('<div class="empty">No jobs yet - ✨ command Goobster to start one.</div>'));
    } else {
        const list = el('<div class="list-card"></div>');
        for (const job of detail.jobs) list.appendChild(jobRow(job));
        viewArea.appendChild(list);
    }

    // The checkpoint file, when the job convention is in use
    if (detail.checkpoint) {
        viewArea.appendChild(el(
            `<details class="obs-tail obs-checkpoint"><summary class="section-title">Latest checkpoint</summary>
               <pre>${escapeText(detail.checkpoint)}</pre></details>`));
    }

    // Image gallery (plots, frames) straight from the workspace
    const images = detail.files.filter(f => f.isImage && f.url).slice(0, 12);
    if (images.length > 0) {
        viewArea.appendChild(el('<div class="section-title">Gallery</div>'));
        const gallery = el('<div class="obs-gallery"></div>');
        for (const image of images) {
            gallery.appendChild(el(
                `<a href="${image.url}" target="_blank" rel="noopener" title="${escapeText(image.path)}">
                   <img src="${image.url}" alt="${escapeText(image.path)}" loading="lazy">
                   <span>${escapeText(image.path)}</span>
                 </a>`));
        }
        viewArea.appendChild(gallery);
    }

    // Every workspace file, newest first
    viewArea.appendChild(el(
        `<div class="section-title">Files (${detail.totalFiles}, ${p.sizeMb}/${p.quotaMb} MB)</div>`));
    if (detail.files.length === 0) {
        viewArea.appendChild(el('<div class="empty">The workspace is empty.</div>'));
    } else {
        const list = el('<div class="list-card"></div>');
        for (const file of detail.files) {
            list.appendChild(el(`
              <div class="list-row task-row">
                <div class="row-body">
                  ${file.url
                    ? `<a href="${file.url}" target="_blank" rel="noopener">${escapeText(file.path)}</a>`
                    : `<span>${escapeText(file.path)}</span>`}
                  <div class="row-meta">${sizeLabel(file.size)} · ${whenLabel(file.modifiedAt)}</div>
                </div>
              </div>`));
        }
        viewArea.appendChild(list);
        if (detail.totalFiles > detail.files.length) {
            viewArea.appendChild(el(
                `<div class="hint">Newest ${detail.files.length} of ${detail.totalFiles} files shown.</div>`));
        }
    }
}

/* ---------- view switching ---------- */

function showList() {
    view = 'list';
    openProject = null;
    lastListPrint = null;
    lastDetailPrint = null;
    detailHasRunning = false;
    titleEl.textContent = 'The Observatory';
    backBtn.classList.add('hidden');
    renderList();
}

function showDetail(project) {
    view = 'detail';
    openProject = { slug: project.slug, name: project.name };
    lastDetailPrint = null;
    backBtn.classList.remove('hidden');
    renderDetail(project.slug);
}

function refreshCurrentView() {
    if (view === 'detail' && openProject) renderDetail(openProject.slug);
    else renderList();
}

/* ---------- live updates ---------- */

function pollTick() {
    if (pane.classList.contains('hidden')) return;
    // While the agent works (or jobs run), keep the pane current
    if (command?.active || (view === 'detail' && detailHasRunning)) {
        if (view === 'detail' && openProject) renderDetail(openProject.slug, { silent: true });
        else renderList({ silent: true });
    }
}

/* ---------- the ✨ custom command ---------- */

function openCommandModal() {
    if (command?.active) {
        showToast('Goobster is still working on the previous command.', true);
        return;
    }
    if (view === 'detail' && openProject) {
        commandTitle.textContent = `Command "${openProject.name}"`;
        commandScope.textContent =
            'Goobster continues this project with your instructions - running code in its workspace, '
            + 'starting background jobs, rendering, or fetching data as needed.';
    } else {
        commandTitle.textContent = 'Command the Observatory';
        commandScope.textContent =
            'Goobster acts across your whole Observatory - it can create projects, start or '
            + 'continue runs, and render results.';
    }
    commandInput.value = '';
    openModal(commandBackdrop, { initialFocus: commandInput });
}

/** One chip per tool call in the command strip (chat's activity pattern). */
function commandToolChip(strip, event) {
    if (event.phase === 'start') {
        const chip = el(`<span class="tool-chip running" data-tool="${escapeText(event.name)}">
            <span class="tool-spinner"></span> ${escapeText(event.name)}…</span>`);
        strip.appendChild(chip);
    } else if (event.phase === 'result') {
        const chips = [...strip.querySelectorAll(`.tool-chip.running[data-tool="${CSS.escape(event.name)}"]`)];
        const chip = chips[chips.length - 1];
        if (chip) {
            chip.className = `tool-chip ${event.isError ? 'failed' : 'done'}`;
            chip.textContent = `${event.isError ? '⚠' : '✓'} ${event.name}`;
        }
    }
}

function renderCommandArea() {
    if (!command) {
        commandArea.classList.add('hidden');
        commandArea.replaceChildren();
        return;
    }
    commandArea.classList.remove('hidden');
    commandArea.replaceChildren();
    const box = el(`
      <div class="obs-command">
        <div class="obs-command-head">
          <span>${command.active ? '<span class="tool-spinner"></span>' : (command.error ? '⚠' : '✨')}</span>
          <strong>${escapeText(command.label)}</strong>
          <span style="flex:1"></span>
        </div>
      </div>`);
    const head = box.querySelector('.obs-command-head');
    if (command.active) {
        const stopBtn = el('<button class="btn danger">◼ Stop</button>');
        stopBtn.addEventListener('click', async () => {
            stopBtn.disabled = true;
            try { await api.stop(); } catch { /* already settled */ }
        });
        head.appendChild(stopBtn);
    } else {
        const dismissBtn = el('<button class="btn subtle" title="Dismiss">✕</button>');
        dismissBtn.addEventListener('click', () => {
            command = null;
            renderCommandArea();
        });
        head.appendChild(dismissBtn);
    }
    box.appendChild(command.strip);
    box.appendChild(command.reply);
    commandArea.appendChild(box);
}

async function runCommand() {
    const instructions = commandInput.value.trim();
    if (!instructions) {
        showToast('Tell Goobster what to do first.', true);
        return;
    }
    const project = view === 'detail' && openProject ? openProject : null;
    closeModal(commandBackdrop);

    command = {
        active: true,
        label: project ? `Commanding "${project.name}"…` : 'Commanding the Observatory…',
        strip: el('<div class="obs-command-strip"></div>'),
        reply: el('<div class="obs-command-reply"></div>'),
        error: false
    };
    renderCommandArea();
    // The status card lives at the top of the pane - make sure the
    // feedback is on screen no matter where the user was scrolled.
    content.scrollTop = 0;

    let replyText = '';
    let finalShown = false;
    const showReply = (markdown, isError = false) => {
        command.reply.innerHTML = renderMarkdown(markdown);
        command.reply.classList.toggle('error', isError);
    };
    try {
        await streamObservatoryCommand(
            { project: project?.slug ?? null, instructions },
            {
                onTool: (event) => commandToolChip(command.strip, event),
                onDelta: (text) => {
                    if (finalShown) return;
                    replyText += text;
                    showReply(replyText);
                },
                onMessage: (message) => {
                    // Completed messages supersede the streamed draft
                    finalShown = true;
                    let markdown = message.content || '';
                    for (const attachment of message.attachments || []) {
                        markdown += `\n\n📎 [${attachment.name}](${attachment.url})`;
                    }
                    showReply(markdown, message.isError);
                    if (message.isError) command.error = true;
                },
                onError: (error) => {
                    command.error = true;
                    showReply(error.message || 'Something went wrong.', true);
                }
            }
        );
        command.label = project
            ? `Command finished - "${project.name}"`
            : 'Command finished';
    } catch (error) {
        command.error = true;
        command.label = 'Command failed';
        showReply(error.message, true);
    } finally {
        command.active = false;
        renderCommandArea();
        refreshCurrentView();
    }
}

/**
 * Prepare the Observatory pane (idempotent; refreshes on every visit).
 * @param {Object} params - { toast, confirm }
 */
export function initObservatory({ toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;
    if (!wired) {
        wired = true;
        commandArea = el('<div class="obs-command-area hidden"></div>');
        viewArea = el('<div class="obs-view"></div>');
        content.replaceChildren(commandArea, viewArea);
        refreshBtn.addEventListener('click', refreshCurrentView);
        backBtn.addEventListener('click', showList);
        commandBtn.addEventListener('click', openCommandModal);
        commandRunBtn.addEventListener('click', runCommand);
        document.getElementById('observatory-command-cancel')
            .addEventListener('click', () => closeModal(commandBackdrop));
        commandInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                runCommand();
            }
        });
        pollTimer = setInterval(pollTick, POLL_MS);
        // The interval must never keep a test process alive
        if (typeof pollTimer === 'object') pollTimer.unref?.();
    }
    refreshCurrentView();
}
