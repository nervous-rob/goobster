import { useState } from 'react';
import { api } from '../lib/api';
import { Modal } from './Modal';

export function ForgetModal({
    onClose,
    toast
}: {
    onClose: () => void;
    toast: (message: string, isError?: boolean) => void;
}) {
    const [value, setValue] = useState('');
    const [busy, setBusy] = useState(false);
    const ready = value.trim().toUpperCase() === 'FORGET ME';

    async function run() {
        if (!ready || busy) return;
        setBusy(true);
        try {
            const result = await api.forgetMe(value) as {
                counts: Record<string, number>;
                audit?: { total?: number };
            };
            onClose();
            playTheater(result);
        } catch (error) {
            toast((error as Error).message, true);
            setBusy(false);
        }
    }

    return (
        <Modal onClose={onClose}>
            <h2>Forget me</h2>
            <p className="hint">Type FORGET ME to erase every row Goobster has about you.</p>
            <input className="input" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn danger" disabled={!ready || busy} onClick={run}>
                    {busy ? 'Erasing…' : 'Erase everything'}
                </button>
            </div>
        </Modal>
    );
}

function playTheater({ counts, audit }: { counts: Record<string, number>; audit?: { total?: number } }) {
    const overlay = document.createElement('div');
    overlay.className = 'forget-theater';
    overlay.innerHTML = `
      <img src="/app/next/icons/goobster.svg" alt="" width="64" height="64">
      <h2>Forgetting you.</h2>
      <p class="hint">Watching the rows go.</p>
      <ul class="forget-count-list"></ul>
      <p class="forget-audit hint"></p>`;
    document.body.appendChild(overlay);
    const list = overlay.querySelector('.forget-count-list')!;
    const rows: Array<[string, number]> = [
        ['Memories', Number(counts.memories) || 0],
        ['Facts', Number(counts.userFacts) || 0],
        ['Chats', Number(counts.webConversations) || 0],
        ['Applets', Number(counts.webApplets) || 0],
        ['Follow-ups', Number(counts.followups) || 0],
        ['Sessions', Number(counts.webSessions) || 0]
    ];
    const shown = rows.filter(([, n]) => n > 0);
    if (shown.length === 0) shown.push(['Everything already empty', 0]);
    for (const [label, n] of shown) {
        const li = document.createElement('li');
        li.textContent = n ? `${label} — ${n}` : label;
        list.appendChild(li);
        requestAnimationFrame(() => li.classList.add('gone'));
    }
    const leftover = audit?.total ?? 0;
    overlay.querySelector('.forget-audit')!.textContent = leftover === 0
        ? 'Audit: zero rows left. You can walk out.'
        : `Audit still sees ${leftover} row(s) — tell the host.`;
    setTimeout(() => { window.location.reload(); }, 2800);
}
