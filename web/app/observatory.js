/**
 * Observatory pane: persistent simulation projects and their background
 * jobs. Read-mostly - projects and jobs are created from chat (the
 * `observatory` tool); here you watch job progress, cancel/resume, browse
 * workspace files, play rendered videos inline, and delete projects.
 */
import { api } from './api.js';

const content = document.getElementById('observatory-content');
const refreshBtn = document.getElementById('observatory-refresh-btn');

let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;
let openSlug = null;

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

function jobRow(job, onChanged) {
    const meta = [
        `${job.segments} segment(s)`,
        `${job.resumeCount} resume(s)`,
        job.checkpointAt ? `checkpoint ${whenLabel(job.checkpointAt)}` : null,
        job.finishedAt ? `finished ${whenLabel(job.finishedAt)}` : `heartbeat ${whenLabel(job.lastHeartbeatAt)}`
    ].filter(Boolean).join(' · ');
    const row = el(`
      <div class="list-row task-row">
        <div class="row-body">
          <span class="badge">${STATUS_ICONS[job.status] || ''} ${escapeText(job.status)}</span>
          <strong>Job #${job.id}</strong> <span>${escapeText(job.language)}</span>
          <div class="row-meta">${escapeText(meta)}</div>
          ${job.error ? `<div class="row-meta">${escapeText(job.error)}</div>` : ''}
        </div>
      </div>`);
    if (job.status === 'RUNNING') {
        const btn = el('<button class="btn danger">Cancel</button>');
        btn.addEventListener('click', async () => {
            if (!await confirmDialog(`Cancel job #${job.id}?`)) return;
            try {
                await api.observatoryCancelJob(job.id);
                showToast(`Job #${job.id} cancelled.`);
                onChanged();
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
                onChanged();
            } catch (error) {
                showToast(error.message, true);
            }
        });
        row.appendChild(btn);
    }
    return row;
}

async function renderProject(container, slug) {
    container.innerHTML = '<div class="empty">Loading&hellip;</div>';
    let detail;
    try {
        detail = await api.observatoryProject(slug);
    } catch (error) {
        container.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
        return;
    }
    container.replaceChildren();

    if (detail.jobs.length > 0) {
        container.appendChild(el('<div class="section-title">Jobs</div>'));
        const list = el('<div class="list-card"></div>');
        for (const job of detail.jobs) list.appendChild(jobRow(job, () => renderProject(container, slug)));
        container.appendChild(list);
    }

    // Rendered videos play inline; other files are download links.
    const videos = detail.files.filter(f => f.isVideo && f.url);
    if (videos.length > 0) {
        container.appendChild(el('<div class="section-title">Renders</div>'));
        for (const video of videos.slice(0, 3)) {
            container.appendChild(el(
                `<video src="${video.url}" controls preload="metadata"
                   style="max-width:100%;border-radius:10px;margin-bottom:10px"></video>`));
        }
    }

    container.appendChild(el(
        `<div class="section-title">Files (${detail.totalFiles}, ${detail.sizeMb}/${detail.quotaMb} MB)</div>`));
    if (detail.files.length === 0) {
        container.appendChild(el('<div class="empty">The workspace is empty.</div>'));
        return;
    }
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
    container.appendChild(list);
}

function projectCard(project) {
    const card = el(`
      <div class="list-row task-row" style="flex-wrap:wrap">
        <div class="row-body" role="button" tabindex="0" style="cursor:pointer">
          <strong>🔭 ${escapeText(project.name)}</strong>
          <span class="badge">${escapeText(project.slug)}</span>
          <div class="row-meta">
            ${project.sizeMb}/${project.quotaMb} MB
            · ${project.runningJobs > 0 ? `🟢 ${project.runningJobs} running · ` : ''}${project.totalJobs} job(s)
            · updated ${whenLabel(project.updatedAt)}
          </div>
        </div>
        <button class="row-delete" title="Delete project" aria-label="Delete ${escapeText(project.name)}">✕</button>
        <div class="observatory-detail hidden" style="flex-basis:100%"></div>
      </div>`);

    const detail = card.querySelector('.observatory-detail');
    const toggle = () => {
        const opening = detail.classList.contains('hidden');
        detail.classList.toggle('hidden', !opening);
        openSlug = opening ? project.slug : null;
        if (opening) renderProject(detail, project.slug);
    };
    const body = card.querySelector('.row-body');
    body.addEventListener('click', toggle);
    body.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            toggle();
        }
    });
    card.querySelector('.row-delete').addEventListener('click', async (event) => {
        event.stopPropagation();
        if (!await confirmDialog(
            `Delete "${project.name}" and its whole workspace? Files and job history are gone for good.`)) return;
        try {
            await api.observatoryDeleteProject(project.slug);
            card.remove();
            showToast('Project deleted.');
        } catch (error) {
            showToast(error.message, true);
        }
    });
    return card;
}

async function refresh() {
    content.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const { projects } = await api.observatoryProjects();
        content.replaceChildren();

        if (projects.length === 0) {
            content.appendChild(el(`
              <div class="empty-state" style="margin-top:6vh">
                <div class="empty-logo">🔭</div>
                <div class="empty-title">No projects yet</div>
                <div class="hint" style="max-width:460px;margin:0 auto">
                  Observatory projects are persistent workspaces for long-running simulations.
                  Ask Goobster in chat to create one - e.g. <em>"create an observatory project called
                  galaxy merger and start an N-body run in the background"</em>. Checkpointed jobs
                  keep running while you're away, frames become videos automatically, and everything
                  lands here.
                </div>
              </div>`));
            return;
        }

        content.appendChild(el('<div class="section-title">Projects</div>'));
        const list = el('<div class="list-card"></div>');
        for (const project of projects) list.appendChild(projectCard(project));
        content.appendChild(list);
        content.appendChild(el(
            '<div class="hint" style="margin-top:10px">Projects and jobs are created from chat with the '
            + '<code>observatory</code> tool. Background jobs notify you in your Discord DMs when they finish.</div>'
        ));

        // Keep the previously opened project open across refreshes
        if (openSlug) {
            const stillThere = projects.find(p => p.slug === openSlug);
            if (stillThere) {
                const card = [...list.children].find(c =>
                    c.querySelector('.badge')?.textContent === stillThere.slug);
                card?.querySelector('.row-body')?.click();
            }
        }
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
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
        refreshBtn.addEventListener('click', refresh);
    }
    refresh();
}
