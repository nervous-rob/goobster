import { useCallback } from 'react';
import { Link } from '@tanstack/react-router';
import type { UserSettingsResponse } from '../../lib/types';
import { ConnectionsList } from '../../components/ConnectionsList';
import { diffKeys, useReportDirty, useSectionDraft } from '../../hooks/useUserSettings';
import { Field, SaveBar, SectionHeader } from './SectionFrame';
import { SCOPE_FOR } from './sectionMeta';

type Values = UserSettingsResponse['sections']['connections']['values'];
type Draft = { githubAllowlist: string; notionAllowlist: string };

const toDraft = (v: Values): Draft => ({
    githubAllowlist: (v.githubAllowlist || []).join('\n'),
    notionAllowlist: (v.notionAllowlist || []).join('\n')
});

function lines(value: string): string[] {
    return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function ConnectionsSection({ section, onDirty }: {
    section: UserSettingsResponse['sections']['connections'];
    onDirty: (dirty: boolean) => void;
}) {
    const toChanges = useCallback((draft: Draft, baseline: Draft) => {
        const diff = diffKeys(draft as unknown as Record<string, unknown>, baseline as unknown as Record<string, unknown>);
        if ('githubAllowlist' in diff) diff.githubAllowlist = lines(draft.githubAllowlist);
        if ('notionAllowlist' in diff) diff.notionAllowlist = lines(draft.notionAllowlist);
        return diff;
    }, []);
    const d = useSectionDraft('connections', section, toDraft, toChanges);
    useReportDirty(onDirty, d.dirty);

    return (
        <section className="settings-section" aria-labelledby="settings-connections-title">
            <SectionHeader id="connections" scope={SCOPE_FOR[section.scope]} appliesTo={section.appliesTo} />
            <p className="hint">
                Connected accounts let Goobster act through them for you in the Study, your DMs, and proactive work
                (within your <Link to="/settings/$section" params={{ section: 'initiative' }} hash="boundaries">Initiative boundaries</Link>). Tokens are stored
                encrypted and never shown again; only the connection status and account label appear here.
                Resetting other settings or forgetting preferences never disconnects anything.
            </p>
            <ConnectionsList />

            <Field id="github-allowlist" label="GitHub repos Goobster may use" scope="Your account"
                hint="Optional. Empty means no extra restriction beyond the connected account. Enforced on GitHub tools in DMs and the Study, not just hidden in this menu.">
                <textarea id="github-allowlist-input" className="input" rows={3}
                    value={d.draft.githubAllowlist}
                    placeholder="owner/repo, one per line"
                    onChange={(e) => d.set({ githubAllowlist: e.target.value })} />
            </Field>
            <Field id="notion-allowlist" label="Notion pages Goobster may use" scope="Your account"
                hint="Optional titles, page ids, or URL fragments. Empty means every page shared with the integration. Search and read both honor this list.">
                <textarea id="notion-allowlist-input" className="input" rows={3}
                    value={d.draft.notionAllowlist}
                    placeholder="Page title or id, one per line"
                    onChange={(e) => d.set({ notionAllowlist: e.target.value })} />
            </Field>
            <SaveBar section="connections" draft={d} describe={(k) => ({
                githubAllowlist: 'GitHub allowlist',
                notionAllowlist: 'Notion allowlist'
            }[k] || k)} />
        </section>
    );
}
