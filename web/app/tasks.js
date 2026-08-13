/**
 * Scheduled tasks pane: view, create, toggle, and cancel the user's
 * recurring automations and one-shot reminders. Portal-created tasks run
 * in the DM scope and deliver to the user's Discord DMs.
 */
import { api } from './api.js';
import { openModal, closeModal } from './modal.js';

const content = document.getElementById('tasks-content');
const addBtn = document.getElementById('task-add-btn');
const modalBackdrop = document.getElementById('task-modal-backdrop');
const nameInput = document.getElementById('task-name');
const promptInput = document.getElementById('task-prompt');
const kindSegment = document.getElementById('task-kind');
const recurringFields = document.getElementById('task-recurring-fields');
const onceFields = document.getElementById('task-once-fields');
const scheduleSelect = document.getElementById('task-schedule');
const cronInput = document.getElementById('task-cron');
const dueInput = document.getElementById('task-due');
const saveBtn = document.getElementById('task-save');

let showToast = () => {};
let confirmDialog = async () => false;
let wired = false;
let taskKind = 'recurring';

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

function whenLabel(iso) {
    if (!iso) return '';
    const date = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const CRON_LABELS = new Map([
    ['0 9 * * *', 'Daily at 9:00'],
    ['0 17 * * *', 'Daily at 17:00'],
    ['0 9 * * 1', 'Mondays at 9:00'],
    ['0 9 * * 1-5', 'Weekday mornings'],
    ['0 9 1 * *', 'Monthly (1st)']
]);

function scheduleLabel(task) {
    return CRON_LABELS.get(task.schedule) || task.scheduleLabel || task.schedule;
}

function automationRow(task) {
    const row = el(`
      <div class="list-row task-row${task.enabled ? '' : ' disabled'}">
        <div class="row-body">
          <span class="badge">${task.scope === 'dm' ? 'DM' : escapeText(task.scopeName)}</span>
          <strong>${escapeText(task.name)}</strong>
          <div class="task-prompt">${escapeText(task.prompt)}</div>
          <div class="row-meta">
            ⏱ ${escapeText(scheduleLabel(task))}
            ${task.nextRun ? ` &middot; next ${whenLabel(task.nextRun)}` : ''}
            ${task.lastRun ? ` &middot; last ${whenLabel(task.lastRun)}` : ''}
          </div>
        </div>
        <button class="toggle${task.enabled ? ' on' : ''}" role="switch"
          aria-checked="${task.enabled}" aria-label="Enable ${escapeText(task.name)}"></button>
        <button class="row-delete" title="Delete task" aria-label="Delete ${escapeText(task.name)}">✕</button>
      </div>`);

    row.querySelector('.toggle').addEventListener('click', async (event) => {
        const btn = event.currentTarget;
        btn.disabled = true;
        try {
            const result = await api.toggleAutomation(task.id, !task.enabled);
            task.enabled = result.enabled;
            showToast(result.enabled ? 'Task enabled.' : 'Task paused.');
            refresh();
        } catch (error) {
            showToast(error.message, true);
            btn.disabled = false;
        }
    });
    row.querySelector('.row-delete').addEventListener('click', async () => {
        if (!await confirmDialog(`Delete "${task.name}"? It will never run again.`)) return;
        try {
            await api.deleteAutomation(task.id);
            row.remove();
            showToast('Task deleted.');
        } catch (error) {
            showToast(error.message, true);
        }
    });
    return row;
}

function followupRow(task) {
    const row = el(`
      <div class="list-row task-row">
        <div class="row-body">
          <span class="badge">${task.scope === 'dm' ? 'DM' : escapeText(task.scopeName)}</span>
          <span>${escapeText(task.prompt)}</span>
          <div class="row-meta">🔔 due ${whenLabel(task.dueAt)}</div>
        </div>
        <button class="row-delete" title="Cancel reminder" aria-label="Cancel reminder">✕</button>
      </div>`);
    row.querySelector('.row-delete').addEventListener('click', async () => {
        if (!await confirmDialog('Cancel this reminder?')) return;
        try {
            await api.cancelFollowup(task.id);
            row.remove();
            showToast('Reminder cancelled.');
        } catch (error) {
            showToast(error.message, true);
        }
    });
    return row;
}

async function refresh() {
    content.innerHTML = '<div class="empty">Loading&hellip;</div>';
    try {
        const { automations, followups } = await api.tasks();
        content.replaceChildren();

        if (automations.length === 0 && followups.length === 0) {
            content.appendChild(el(`
              <div class="empty-state" style="margin-top:6vh">
                <div class="empty-logo">🗓️</div>
                <div class="empty-title">Nothing scheduled yet</div>
                <div class="hint" style="max-width:440px;margin:0 auto">
                  Scheduled tasks are prompts Goobster runs for you on a timer - a morning
                  news brief, a weekly recap, a one-off reminder. Results are delivered to
                  your Discord DMs. The same tasks are manageable with <code>/automation</code> in Discord.
                </div>
              </div>`));
            return;
        }

        if (automations.length > 0) {
            content.appendChild(el('<div class="section-title">Repeating tasks</div>'));
            const list = el('<div class="list-card"></div>');
            for (const task of automations) list.appendChild(automationRow(task));
            content.appendChild(list);
        }
        if (followups.length > 0) {
            content.appendChild(el('<div class="section-title">One-shot reminders</div>'));
            const list = el('<div class="list-card"></div>');
            for (const task of followups) list.appendChild(followupRow(task));
            content.appendChild(list);
        }
        content.appendChild(el(
            '<div class="hint" style="margin-top:10px">Repeating tasks run as full agent turns (tools included) and are also manageable with <code>/automation</code> in Discord. Results land in your Discord DMs.</div>'
        ));
    } catch (error) {
        content.innerHTML = `<div class="empty">${escapeText(error.message)}</div>`;
    }
}

function setTaskKind(kind) {
    taskKind = kind;
    for (const btn of kindSegment.querySelectorAll('.segment-btn')) {
        btn.classList.toggle('active', btn.dataset.kind === kind);
    }
    recurringFields.classList.toggle('hidden', kind !== 'recurring');
    onceFields.classList.toggle('hidden', kind !== 'once');
}

function openTaskModal() {
    nameInput.value = '';
    promptInput.value = '';
    scheduleSelect.value = '0 9 * * *';
    cronInput.value = '';
    cronInput.classList.add('hidden');
    // Default the one-shot picker to an hour from now, local time
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    soon.setMinutes(soon.getMinutes() - soon.getTimezoneOffset());
    dueInput.value = soon.toISOString().slice(0, 16);
    setTaskKind('recurring');
    openModal(modalBackdrop, { initialFocus: nameInput });
}

async function saveTask() {
    const name = nameInput.value.trim();
    const prompt = promptInput.value.trim();
    if (!name || !prompt) {
        showToast('A task needs a name and a prompt.', true);
        return;
    }
    const body = { name, prompt };
    if (taskKind === 'recurring') {
        body.cron = scheduleSelect.value === 'custom' ? cronInput.value.trim() : scheduleSelect.value;
        if (!body.cron) {
            showToast('Enter a cron expression.', true);
            return;
        }
    } else {
        if (!dueInput.value) {
            showToast('Pick a time.', true);
            return;
        }
        body.dueAt = new Date(dueInput.value).toISOString();
    }
    saveBtn.disabled = true;
    try {
        await api.createTask(body);
        closeModal(modalBackdrop);
        showToast('Task scheduled.');
        refresh();
    } catch (error) {
        showToast(error.message, true);
    } finally {
        saveBtn.disabled = false;
    }
}

/**
 * Prepare the tasks pane (idempotent; refreshes on every visit).
 * @param {Object} params - { me, toast, confirm }
 */
export function initTasks({ toast, confirm }) {
    showToast = toast;
    confirmDialog = confirm;

    if (!wired) {
        wired = true;
        addBtn.addEventListener('click', openTaskModal);
        saveBtn.addEventListener('click', saveTask);
        document.getElementById('task-cancel').addEventListener('click', () => closeModal(modalBackdrop));
        kindSegment.addEventListener('click', (event) => {
            const btn = event.target.closest('.segment-btn');
            if (btn) setTaskKind(btn.dataset.kind);
        });
        scheduleSelect.addEventListener('change', () => {
            cronInput.classList.toggle('hidden', scheduleSelect.value !== 'custom');
            if (scheduleSelect.value === 'custom') cronInput.focus();
        });
    }

    refresh();
}
