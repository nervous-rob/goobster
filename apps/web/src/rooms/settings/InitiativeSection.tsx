import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { keys } from '../../lib/query';
import type { UserSettingsResponse } from '../../lib/types';
import { diffKeys, useApplySectionResult, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { useToast } from '../../hooks/useToast';
import { useConfirm } from '../../hooks/useConfirm';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['initiative']['values'];
type Boundary = { proactiveRead?: boolean; proactiveCompute?: boolean; externalWrite?: string | boolean };
type Draft = {
    initiative: string;
    maxContactsPerDay: string;
    contactCooldownMinutes: string;
    quietStart: string;
    quietEnd: string;
    boundaries: Record<string, Boundary>;
};

const INITIATIVE_BLURB: Record<string, string> = {
    observe: 'Only notices things. Fills the Noticed inbox, never reaches out.',
    nudge: 'May send a DM about something that clearly matters to you.',
    assist: 'May also do read-only work ahead of time (research, digests) and offer it.',
    delegate: 'May take actions you have approved elsewhere, and asks before anything external.'
};

const CATEGORY_LABEL: Record<string, string> = {
    general: 'General', research: 'Research', observatory: 'Observatory projects',
    knowledge: 'Knowledge & memory', schedule: 'Schedule & tasks', github: 'GitHub'
};

const LABELS: Record<string, string> = {
    enabled: 'Paying attention', initiative: 'Initiative level', maxContactsPerDay: 'DMs per day',
    contactCooldownMinutes: 'Minutes between DMs', quietStartMinute: 'Quiet hours start',
    quietEndMinute: 'Quiet hours end', boundaries: 'Boundaries'
};

const minuteToTime = (m: number | null) => (m === null || m === undefined ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
const timeToMinute = (t: string): number | null => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
    return h * 60 + m;
};

const toDraft = (v: Values): Draft => ({
    initiative: v.initiative || 'nudge',
    maxContactsPerDay: String(v.maxContactsPerDay ?? 3),
    contactCooldownMinutes: String(v.contactCooldownMinutes ?? 120),
    quietStart: minuteToTime(v.quietStartMinute),
    quietEnd: minuteToTime(v.quietEndMinute),
    boundaries: v.boundaries || {}
});

export function InitiativeSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['initiative'];
    onDirty: (dirty: boolean) => void;
}) {
    const toast = useToast();
    const confirm = useConfirm();
    const queryClient = useQueryClient();
    const applyResult = useApplySectionResult();

    // `enabled` is deliberately NOT part of the draft: turning attention on or
    // off is its own explicit action, and saving a budget or boundary must
    // never re-enable a disabled policy.
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        const out: Record<string, unknown> = {};
        if ('initiative' in diff) out.initiative = draft.initiative;
        if ('maxContactsPerDay' in diff) out.maxContactsPerDay = Number(draft.maxContactsPerDay);
        if ('contactCooldownMinutes' in diff) out.contactCooldownMinutes = Number(draft.contactCooldownMinutes);
        if ('quietStart' in diff || 'quietEnd' in diff) {
            out.quietStartMinute = timeToMinute(draft.quietStart);
            out.quietEndMinute = timeToMinute(draft.quietEnd);
        }
        if ('boundaries' in diff) out.boundaries = draft.boundaries;
        return out;
    }, []);
    const d = useSectionDraft('initiative', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    const enabled = Boolean(section.values.enabled);
    const [toggling, setToggling] = useState(false);
    async function toggleEnabled() {
        if (enabled) {
            const ok = await confirm('Stop paying attention? Existing notices stay in the inbox; nothing new is generated and he will not DM you.');
            if (!ok) return;
        }
        setToggling(true);
        try {
            const result = await api.updateSettingsSection('initiative', {
                expectedRevision: section.revision,
                changes: { enabled: !enabled }
            });
            applyResult(result);
            await queryClient.invalidateQueries({ queryKey: keys.attention });
            toast(!enabled ? 'Goobster is paying attention.' : 'Attention off.');
        } catch (error) {
            toast((error as Error).message, true);
        } finally {
            setToggling(false);
        }
    }

    const categories = section.categories || Object.keys(section.effective.boundaries || {});
    const effectiveBoundaries = (section.effective.boundaries || {}) as Record<string, Boundary>;
    const levels = section.initiativeLevels || ['observe', 'nudge', 'assist', 'delegate'];

    const quietMismatch = Boolean(d.draft.quietStart) !== Boolean(d.draft.quietEnd);
    const perDay = Number(d.draft.maxContactsPerDay);
    const cooldown = Number(d.draft.contactCooldownMinutes);
    const budgetError = !Number.isInteger(perDay) || perDay < 0 || perDay > 20
        ? 'DMs per day must be a whole number from 0 to 20.'
        : !Number.isInteger(cooldown) || cooldown < 5 || cooldown > 1440
            ? 'Cooldown must be between 5 and 1440 minutes.' : null;

    function setBoundary(category: string, patch: Boundary) {
        const current = { ...(effectiveBoundaries[category] || {}), ...(d.draft.boundaries[category] || {}), ...patch };
        d.set({ boundaries: { ...d.draft.boundaries, [category]: current } });
    }

    return (
        <section className="settings-section" aria-labelledby="settings-initiative-title">
            <SectionHeader id="initiative" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />

            <Field id="attention-enabled" label="Pay attention on my behalf" inline
                hint={enabled
                    ? 'On. He reviews what he can see, keeps a Noticed inbox, and may reach out within the limits below.'
                    : 'Off. Nothing is generated and he never reaches out. You can still edit the limits below; they take effect when you turn this on.'}>
                <button id="attention-enabled-input" type="button" className={`toggle${enabled ? ' on' : ''}`}
                    role="switch" aria-checked={enabled} aria-label="Pay attention on my behalf"
                    disabled={toggling} onClick={toggleEnabled} />
            </Field>

            <Field id="initiative-level" label="Initiative level" hint={INITIATIVE_BLURB[d.draft.initiative]}>
                <div className="segment settings-segment" role="radiogroup" aria-label="Initiative level" id="initiative-level-input">
                    {levels.map((level) => (
                        <button key={level} type="button" role="radio" aria-checked={d.draft.initiative === level}
                            className={`segment-btn${d.draft.initiative === level ? ' active' : ''}`}
                            onClick={() => d.set({ initiative: level })}>{level}</button>
                    ))}
                </div>
            </Field>

            <Field id="contact-budget" label="Contact budget"
                hint="A cap of 0 DMs per day means everything stays in the Noticed inbox." error={budgetError}>
                <div className="settings-inline-row">
                    <label className="settings-mini">
                        <span>DMs per day</span>
                        <input id="contact-budget-input" className="input" type="number" inputMode="numeric" min={0} max={20}
                            value={d.draft.maxContactsPerDay} onChange={(e) => d.set({ maxContactsPerDay: e.target.value })} />
                    </label>
                    <label className="settings-mini">
                        <span>Minutes between DMs</span>
                        <input className="input" type="number" inputMode="numeric" min={5} max={1440}
                            value={d.draft.contactCooldownMinutes} onChange={(e) => d.set({ contactCooldownMinutes: e.target.value })} />
                    </label>
                </div>
            </Field>

            <Field id="quiet-hours" label="Quiet hours (UTC)"
                hint="Notices still accumulate; only outbound contact waits. Overnight ranges (e.g. 22:00 → 07:00) are fine. Clear both to disable."
                error={quietMismatch ? 'Set both a start and an end, or clear both.' : null}>
                <div className="settings-inline-row">
                    <label className="settings-mini">
                        <span>From</span>
                        <input id="quiet-hours-input" className="input" type="time" value={d.draft.quietStart}
                            onChange={(e) => d.set({ quietStart: e.target.value })} />
                    </label>
                    <label className="settings-mini">
                        <span>Until</span>
                        <input className="input" type="time" value={d.draft.quietEnd}
                            onChange={(e) => d.set({ quietEnd: e.target.value })} />
                    </label>
                    {(d.draft.quietStart || d.draft.quietEnd) && (
                        <button type="button" className="btn subtle small" onClick={() => d.set({ quietStart: '', quietEnd: '' })}>Clear</button>
                    )}
                </div>
            </Field>

            <Field id="boundaries" label="Boundaries by category"
                hint="What he may do ahead of time in each area. The initiative level above still gates all of it, and external writes always respect each integration's own approvals.">
                <div className="list-card settings-boundaries" id="boundaries-input">
                    <div className="settings-boundary-row head" aria-hidden="true">
                        <span>Area</span><span>Read ahead</span><span>Compute ahead</span><span>External writes</span>
                    </div>
                    {categories.map((cat) => {
                        const eff = { ...(effectiveBoundaries[cat] || {}), ...(d.draft.boundaries[cat] || {}) };
                        const write = eff.externalWrite === true ? 'true' : eff.externalWrite === 'confirm' ? 'confirm' : 'never';
                        return (
                            <div key={cat} className="settings-boundary-row">
                                <span className="settings-boundary-name">{CATEGORY_LABEL[cat] || cat}</span>
                                <label className="settings-check"><input type="checkbox" checked={eff.proactiveRead === true}
                                    onChange={(e) => setBoundary(cat, { proactiveRead: e.target.checked })} /><span className="narrow-only">Read</span></label>
                                <label className="settings-check"><input type="checkbox" checked={eff.proactiveCompute === true}
                                    onChange={(e) => setBoundary(cat, { proactiveCompute: e.target.checked })} /><span className="narrow-only">Compute</span></label>
                                <select className="select small" aria-label={`External writes for ${CATEGORY_LABEL[cat] || cat}`} value={write}
                                    onChange={(e) => setBoundary(cat, { externalWrite: e.target.value === 'true' ? true : e.target.value })}>
                                    <option value="never">Never</option>
                                    <option value="confirm">Ask first</option>
                                    <option value="true">Allowed</option>
                                </select>
                            </div>
                        );
                    })}
                </div>
            </Field>

            <SaveBar section="initiative" draft={d} describe={(k) => LABELS[k] || k} />
        </section>
    );
}
