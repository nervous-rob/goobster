import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { keys } from '../lib/query';
import { useToast } from '../hooks/useToast';
import { useConfirm } from '../hooks/useConfirm';
import { Modal } from '../components/Modal';
import { MenuButton } from '../shell/MenuButton';

/**
 * The Assistant Inbox: everything Goobster noticed but judged not worth
 * interrupting you about, plus the ledger of open loops behind those
 * judgements and the dials that govern how loud he is allowed to be.
 *
 * The pane deliberately cannot create an open loop. Loops come from evidence
 * — something you said, a reflection pass, a tool call he made — so every one
 * of them can be traced back to why he believes it. A ledger you could type
 * into would just be a task list.
 */

type Notice = {
    id: number;
    itemId: number | null;
    itemSubject: string | null;
    category: string;
    title: string;
    detail: string | null;
    disposition: 'inbox' | 'mention' | 'dm' | 'urgent';
    status: string;
    reason: string | null;
    score: number;
    factors: {
        urgency: number; importance: number; confidence: number;
        actionability: number; interruptionCost: number;
    };
    createdAt: string;
};

type Item = {
    id: number;
    kind: string;
    subject: string;
    goal: string | null;
    unresolved: string[];
    state: string;
    importance: number;
    confidence: number;
    category: string;
    deadlineAt: string | null;
    lastActivityAt: string | null;
};

type Watch = {
    id: number;
    label: string;
    topic: string;
    condition: Record<string, unknown> | null;
    prompt: string;
    status: string;
    lastFiredAt: string | null;
    lastError: string | null;
};

type Policy = {
    initiative: string;
    quietStartMinute: number | null;
    quietEndMinute: number | null;
    maxContactsPerDay: number;
    contactCooldownMinutes: number;
    enabled: boolean;
};

type Calibration = {
    category: string; surfaced: number; dismissed: number; actedOn: number; samples: number;
};

type Overview = {
    enrolled: boolean;
    policy: Policy | null;
    notices: Notice[];
    items: Item[];
    watches: Watch[];
    calibration: Calibration[];
    initiativeLevels: string[];
};

const INITIATIVE_BLURB: Record<string, string> = {
    observe: 'Notices and remembers, never reaches out. Everything lands here for you to look at.',
    nudge: 'May surface things he thinks are useful, including a DM when something warrants one.',
    assist: 'As nudge, plus reversible read-only work done on your behalf and reported back.',
    delegate: 'As assist, plus he may start pre-authorized kinds of action without asking first.'
};

/** A hollow bullet is something he chose not to bother you with. */
const DISPOSITION_MARK: Record<string, string> = {
    inbox: '○', mention: '◐', dm: '●', urgent: '❗'
};

const STATE_MARK: Record<string, string> = {
    candidate: '○', corroborated: '◐', active: '●'
};

function whenLabel(stamp?: string | null) {
    if (!stamp) return '';
    const date = new Date(stamp.includes('T') ? stamp : `${stamp.replace(' ', 'T')}Z`);
    if (Number.isNaN(date.getTime())) return stamp;
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function deadlineLabel(stamp: string | null) {
    if (!stamp) return null;
    const due = new Date(`${stamp.replace(' ', 'T')}Z`).getTime();
    if (Number.isNaN(due)) return null;
    const days = Math.round((due - Date.now()) / 86_400_000);
    if (days < 0) return `overdue by ${Math.abs(days)}d`;
    if (days === 0) return 'due today';
    return `due in ${days}d`;
}

function hourLabel(minute: number | null) {
    if (minute === null) return null;
    return `${String(Math.floor(minute / 60)).padStart(2, '0')}:00`;
}

export function NoticedRoom() {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [explaining, setExplaining] = useState<Notice | null>(null);

    const overview = useQuery({
        queryKey: keys.attention,
        queryFn: () => api.attention() as Promise<Overview>
    });

    const invalidate = () => queryClient.invalidateQueries({ queryKey: keys.attention });

    async function act(notice: Notice, action: string, label: string) {
        try {
            await api.attentionActOnNotice(notice.id, action);
            toast(label);
            invalidate();
        } catch (error) { toast((error as Error).message, true); }
    }

    if (overview.isPending) {
        return (
            <main className="pane next-pane is-in">
                <div className="pane-body"><div className="empty">Loading…</div></div>
            </main>
        );
    }
    if (overview.isError) {
        return (
            <main className="pane next-pane is-in">
                <div className="pane-body"><div className="empty">{(overview.error as Error).message}</div></div>
            </main>
        );
    }

    const data = overview.data as Overview;

    if (!data.enrolled) {
        return (
            <main className="pane next-pane is-in">
                <header className="pane-header">
                    <div className="title-row">
                        <MenuButton />
                        <h1>Noticed</h1>
                    </div>
                </header>
                <div className="pane-body">
                    <div className="empty-state" style={{ marginTop: '6vh' }}>
                        <div className="empty-logo">🧭</div>
                        <div className="empty-title">Goobster isn't paying attention yet</div>
                        <div className="hint" style={{ maxWidth: 520, margin: '0 auto 18px' }}>
                            Turn this on and he keeps a small ledger of your open loops — commitments,
                            deadlines, things you're waiting on — and checks whether anything about them
                            changed. Most of what he notices lands here quietly rather than reaching you;
                            he only messages you when something clears a fairly high bar, and dismissing
                            things teaches him to raise that kind less.
                        </div>
                        <button type="button" className="btn primary" onClick={async () => {
                            try {
                                await api.attentionEnroll('nudge');
                                toast('Proactive attention on.');
                                invalidate();
                            } catch (error) { toast((error as Error).message, true); }
                        }}>Start paying attention</button>
                    </div>
                </div>
            </main>
        );
    }

    const policy = data.policy as Policy;
    const quiet = hourLabel(policy.quietStartMinute);

    return (
        <main className="pane next-pane is-in">
            <header className="pane-header">
                <div className="title-row">
                    <MenuButton />
                    <h1>Noticed</h1>
                </div>
                <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>⚙ Initiative</button>
            </header>
            <div className="pane-body">
                <div className="row-meta" style={{ marginBottom: 14 }}>
                    Initiative <strong>{policy.initiative}</strong> · at most {policy.maxContactsPerDay} DMs/day,
                    {' '}{policy.contactCooldownMinutes} min apart
                    {quiet ? ` · quiet ${quiet}–${hourLabel(policy.quietEndMinute)} UTC` : ''}
                </div>

                {data.notices.length === 0 && (
                    <div className="empty-state" style={{ marginTop: '4vh' }}>
                        <div className="empty-logo">🔔</div>
                        <div className="empty-title">Nothing to report</div>
                        <div className="hint" style={{ maxWidth: 440, margin: '0 auto' }}>
                            Either nothing changed, or nothing that changed was worth your time.
                            Deciding not to tell you is part of the job.
                        </div>
                    </div>
                )}

                {data.notices.length > 0 && (
                    <>
                        <div className="section-title">Goobster noticed</div>
                        <div className="list-card">
                            {data.notices.map((notice) => (
                                <div key={notice.id} className="list-row task-row">
                                    <div className="row-body">
                                        <span className="badge">{DISPOSITION_MARK[notice.disposition]} {notice.category}</span>
                                        <strong>{notice.title}</strong>
                                        {notice.detail && <div className="task-prompt">{notice.detail}</div>}
                                        <div className="row-meta">
                                            {whenLabel(notice.createdAt)}
                                            {notice.reason ? ` · ${notice.reason}` : ''}
                                            {' · '}
                                            <button type="button" className="btn subtle" style={{ padding: '0 4px' }}
                                                onClick={() => setExplaining(notice)}>why?</button>
                                        </div>
                                    </div>
                                    <button type="button" className="btn subtle"
                                        onClick={() => act(notice, 'act', 'Marked as acted on.')}>Acted</button>
                                    <button type="button" className="btn subtle"
                                        onClick={() => act(notice, 'snooze', 'Snoozed for a day.')}>Snooze</button>
                                    <button type="button" className="row-delete" aria-label={`Dismiss ${notice.title}`}
                                        onClick={() => act(notice, 'dismiss', 'Dismissed — he\'ll raise that kind less.')}>✕</button>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {data.items.length > 0 && (
                    <>
                        <div className="section-title">Open loops he's tracking</div>
                        <div className="list-card">
                            {data.items.map((item) => (
                                <div key={item.id} className="list-row task-row">
                                    <div className="row-body">
                                        <span className="badge">{STATE_MARK[item.state] || '•'} {item.kind}</span>
                                        <strong>{item.subject}</strong>
                                        {item.goal && <div className="task-prompt">{item.goal}</div>}
                                        <div className="row-meta">
                                            {item.state === 'candidate' ? 'unconfirmed guess' : item.state}
                                            {' · '}confidence {Math.round(item.confidence * 100)}%
                                            {item.deadlineAt ? ` · ${deadlineLabel(item.deadlineAt)}` : ''}
                                            {item.lastActivityAt ? ` · last touched ${whenLabel(item.lastActivityAt)}` : ''}
                                        </div>
                                        {item.unresolved.length > 0 && (
                                            <div className="row-meta">Still open: {item.unresolved.join('; ')}</div>
                                        )}
                                    </div>
                                    <button type="button" className="btn subtle" onClick={async () => {
                                        try {
                                            await api.attentionResolveItem(item.id, 'resolved');
                                            toast('Closed.');
                                            invalidate();
                                        } catch (error) { toast((error as Error).message, true); }
                                    }}>Done</button>
                                    <button type="button" className="row-delete" aria-label={`Drop ${item.subject}`}
                                        onClick={async () => {
                                            if (!await confirm(`Stop tracking "${item.subject}"?`)) return;
                                            try {
                                                await api.attentionResolveItem(item.id, 'abandoned');
                                                toast('Dropped.');
                                                invalidate();
                                            } catch (error) { toast((error as Error).message, true); }
                                        }}>✕</button>
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {data.watches.length > 0 && (
                    <>
                        <div className="section-title">Waiting on conditions</div>
                        <div className="list-card">
                            {data.watches.map((watch) => (
                                <div key={watch.id} className={`list-row task-row${watch.status === 'ARMED' ? '' : ' disabled'}`}>
                                    <div className="row-body">
                                        <span className="badge">{watch.status.toLowerCase()}</span>
                                        <strong>{watch.label}</strong>
                                        <div className="task-prompt">{watch.prompt}</div>
                                        <div className="row-meta">
                                            when <code>{watch.topic}</code>
                                            {watch.condition ? ` ${JSON.stringify(watch.condition)}` : ''}
                                            {watch.lastFiredAt ? ` · fired ${whenLabel(watch.lastFiredAt)}` : ''}
                                            {watch.lastError ? ` · failed: ${watch.lastError}` : ''}
                                        </div>
                                    </div>
                                    {watch.status === 'ARMED' && (
                                        <button type="button" className="row-delete" aria-label={`Disarm ${watch.label}`}
                                            onClick={async () => {
                                                try {
                                                    await api.attentionCancelWatch(watch.id);
                                                    toast('Watch disarmed.');
                                                    invalidate();
                                                } catch (error) { toast((error as Error).message, true); }
                                            }}>✕</button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </>
                )}

                {data.calibration.some((row) => row.samples > 0) && (
                    <>
                        <div className="section-title">What he's learned about interrupting you</div>
                        <div className="list-card">
                            {data.calibration.filter((row) => row.samples > 0).map((row) => (
                                <div key={row.category} className="list-row task-row">
                                    <div className="row-body">
                                        <strong>{row.category}</strong>
                                        <div className="row-meta">
                                            {row.surfaced} raised · {row.actedOn} acted on · {row.dismissed} dismissed
                                            {row.dismissed > row.actedOn
                                                ? ' — raising the bar here'
                                                : row.actedOn > row.dismissed ? ' — lowering the bar here' : ''}
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </>
                )}
            </div>

            {explaining && <ExplainModal notice={explaining} onClose={() => setExplaining(null)} />}
            {settingsOpen && (
                <InitiativeModal
                    policy={policy}
                    levels={data.initiativeLevels}
                    onClose={() => setSettingsOpen(false)}
                    onSaved={() => { setSettingsOpen(false); invalidate(); }}
                />
            )}
        </main>
    );
}

/** "Why did you tell me this?" - the score inputs behind one decision. */
function ExplainModal({ notice, onClose }: { notice: Notice; onClose: () => void }) {
    const rows: Array<[string, number, string]> = [
        ['Urgency', notice.factors.urgency, 'how time-pressured this is'],
        ['Importance', notice.factors.importance, 'how much it seems to matter to you'],
        ['Confidence', notice.factors.confidence, 'how sure he is he understood it'],
        ['Actionability', notice.factors.actionability, 'whether there is something to do'],
        ['Interruption cost', notice.factors.interruptionCost, 'what speaking up costs right now']
    ];
    return (
        <Modal onClose={onClose}>
            <h2>Why he raised this</h2>
            <div className="task-prompt" style={{ marginBottom: 12 }}>{notice.title}</div>
            <div className="list-card">
                {rows.map(([label, value, hint]) => (
                    <div key={label} className="list-row">
                        <div className="row-body">
                            <strong>{label}</strong> {value.toFixed(2)}
                            <div className="row-meta">{hint}</div>
                        </div>
                    </div>
                ))}
            </div>
            <div className="row-meta" style={{ marginTop: 12 }}>
                The first four multiply together, then the interruption cost is subtracted, giving{' '}
                <strong>{notice.score.toFixed(2)}</strong> — enough for <strong>{notice.disposition}</strong>.
                A single weak factor is enough to keep him quiet.
            </div>
            <div className="modal-actions">
                <button type="button" className="btn primary" onClick={onClose}>Close</button>
            </div>
        </Modal>
    );
}

function InitiativeModal({ policy, levels, onClose, onSaved }: {
    policy: Policy; levels: string[]; onClose: () => void; onSaved: () => void;
}) {
    const toast = useToast();
    const [initiative, setInitiative] = useState(policy.initiative);
    const [perDay, setPerDay] = useState(String(policy.maxContactsPerDay));
    const [cooldown, setCooldown] = useState(String(policy.contactCooldownMinutes));
    const [quietStart, setQuietStart] = useState(
        policy.quietStartMinute === null ? '' : String(Math.floor(policy.quietStartMinute / 60)));
    const [quietEnd, setQuietEnd] = useState(
        policy.quietEndMinute === null ? '' : String(Math.floor(policy.quietEndMinute / 60)));
    const [saving, setSaving] = useState(false);

    async function save() {
        setSaving(true);
        try {
            await api.attentionUpdatePolicy({
                initiative,
                maxContactsPerDay: Number(perDay),
                contactCooldownMinutes: Number(cooldown),
                quietStartMinute: quietStart === '' ? null : Number(quietStart) * 60,
                quietEndMinute: quietEnd === '' ? null : Number(quietEnd) * 60
            });
            toast('Initiative updated.');
            onSaved();
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal onClose={onClose}>
            <h2>How much initiative?</h2>
            <select className="select" value={initiative} onChange={(e) => setInitiative(e.target.value)}>
                {levels.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
            <div className="row-meta" style={{ margin: '6px 0 14px' }}>{INITIATIVE_BLURB[initiative]}</div>

            <div className="section-title">Contact budget</div>
            <input className="input" type="number" min={0} max={20} value={perDay}
                onChange={(e) => setPerDay(e.target.value)} placeholder="Max DMs per day" />
            <input className="input" type="number" min={5} max={1440} value={cooldown}
                onChange={(e) => setCooldown(e.target.value)} placeholder="Minutes between DMs" />
            <div className="row-meta" style={{ marginBottom: 14 }}>
                Set the daily cap to 0 and he will never DM you — everything stays in this pane.
            </div>

            <div className="section-title">Quiet hours (UTC)</div>
            <input className="input" type="number" min={0} max={23} value={quietStart}
                onChange={(e) => setQuietStart(e.target.value)} placeholder="Start hour (blank for none)" />
            <input className="input" type="number" min={0} max={23} value={quietEnd}
                onChange={(e) => setQuietEnd(e.target.value)} placeholder="End hour" />
            <div className="row-meta">Notices still accumulate during quiet hours; only contact waits.</div>

            <div className="modal-actions">
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
                <button type="button" className="btn primary" disabled={saving} onClick={save}>Save</button>
            </div>
        </Modal>
    );
}
