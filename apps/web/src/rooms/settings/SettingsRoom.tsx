import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import { useUserSettings } from '../../hooks/useUserSettings';
import { useMe } from '../../hooks/useSession';
import { useConfirm } from '../../hooks/useConfirm';
import { MenuButton } from '../../shell/MenuButton';
import type { SettingsSectionId } from '../../lib/types';
import { SECTIONS, SECTION_BY_ID, isSectionId, searchSettings } from './sectionMeta';
import { useFieldAnchor } from './SectionFrame';
import { ProfileSection } from './ProfileSection';
import { ChatSection } from './ChatSection';
import { VoiceSection } from './VoiceSection';
import { InitiativeSection } from './InitiativeSection';
import { MemorySection } from './MemorySection';
import { ConnectionsSection } from './ConnectionsSection';
import { AppearanceSection } from './AppearanceSection';
import { AccountSection } from './AccountSection';

const UNSAVED = 'You have unsaved settings changes. Leave and discard them?';

const ROOM_NAMES: Record<string, string> = {
    study: 'the Study', noticed: 'Noticed', spitball: 'Spitball', parlor: 'the Parlor',
    library: 'the Library', workshop: 'the Workshop', observatory: 'the Observatory'
};

function roomName(href: string): string {
    const first = href.replace(/^\//, '').split(/[/?#]/)[0] || '';
    return ROOM_NAMES[first] || 'where you were';
}

/**
 * One searchable home for every personal setting.
 *
 * Desktop: section list on the left, the section on the right. Narrow
 * screens: the list is a page, and each section is a page with Back.
 * Deep links are `/settings/<section>#<field>` — search results land on the
 * control, not just the section.
 */
export function SettingsRoom() {
    const me = useMe();
    const navigate = useNavigate();
    const confirm = useConfirm();
    const params = useParams({ strict: false }) as { section?: string };
    const hash = useRouterState({ select: (s) => s.location.hash });
    const returnTo = useRouterState({ select: (s) => s.location.state.settingsReturnTo });
    const settings = useUserSettings();

    const active: SettingsSectionId | null = isSectionId(params.section) ? params.section : null;
    const [query, setQuery] = useState('');
    const hits = useMemo(() => searchSettings(query), [query]);
    const searchRef = useRef<HTMLInputElement>(null);

    // Dirty registry: each section reports; the room guards navigation.
    const [dirty, setDirty] = useState<Record<string, boolean>>({});
    const anyDirty = Object.values(dirty).some(Boolean);
    const markDirty = useCallback((section: SettingsSectionId) => (value: boolean) => {
        setDirty((prev) => (prev[section] === value ? prev : { ...prev, [section]: value }));
    }, []);
    useBlocker({
        shouldBlockFn: async () => {
            if (!anyDirty) return false;
            const leave = await confirm(UNSAVED);
            return !leave;
        },
        enableBeforeUnload: anyDirty
    });
    useFieldAnchor(active ? hash || null : null);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === '/' && !event.metaKey && !event.ctrlKey && document.activeElement?.tagName !== 'INPUT'
                && document.activeElement?.tagName !== 'TEXTAREA') {
                event.preventDefault();
                searchRef.current?.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    function go(section: SettingsSectionId, field?: string) {
        setQuery('');
        navigate({ to: '/settings/$section', params: { section }, hash: field || undefined });
    }

    const data = settings.data;
    const listOnlyOnMobile = !active;

    return (
        <main className={`pane next-pane is-in settings-room${active ? ' has-section' : ''}`} id="pane-settings">
            <header className="pane-header">
                <div className="title-row settings-title-row">
                    <MenuButton />
                    {active && (
                        <Link to="/settings" className="btn subtle settings-back" aria-label="Back to all settings">← All settings</Link>
                    )}
                    <h1>{active ? SECTION_BY_ID[active].title : 'Settings'}</h1>
                    {returnTo && (
                        <Link to={returnTo} className="btn subtle settings-return" title={`Back to ${roomName(returnTo)}`}>
                            ↩ Back to {roomName(returnTo)}
                        </Link>
                    )}
                </div>
                <div className="settings-search">
                    <input
                        ref={searchRef}
                        className="input"
                        type="search"
                        role="combobox"
                        aria-expanded={hits.length > 0}
                        aria-controls="settings-search-results"
                        aria-label="Search settings"
                        placeholder="Search settings — try “call me”, “quiet”, “thinking”"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter' && hits[0] && !(e.nativeEvent as KeyboardEvent).isComposing) {
                                go(hits[0].section.id, hits[0].field.fieldId);
                            }
                            if (e.key === 'Escape') setQuery('');
                        }}
                    />
                    {query && (
                        <ul id="settings-search-results" className="settings-search-results" role="listbox">
                            {hits.length === 0 && <li className="hint settings-search-empty">Nothing matches “{query}”.</li>}
                            {hits.map((hit) => (
                                <li key={`${hit.section.id}:${hit.field.fieldId}`} role="option" aria-selected={false}>
                                    <button type="button" onClick={() => go(hit.section.id, hit.field.fieldId)}>
                                        <span className="settings-hit-label">{hit.field.label}</span>
                                        <span className="hint">{hit.section.icon} {hit.section.title} · {hit.section.scope}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </header>
            <div className="settings-layout">
                <nav className={`settings-nav${listOnlyOnMobile ? '' : ' narrow-hidden'}`} aria-label="Settings sections">
                    {SECTIONS.map((s) => (
                        <Link key={s.id} to="/settings/$section" params={{ section: s.id }}
                            className={`settings-nav-item${active === s.id ? ' active' : ''}`}
                            aria-current={active === s.id ? 'page' : undefined}>
                            <span className="settings-nav-icon" aria-hidden="true">{s.icon}</span>
                            <span className="settings-nav-text">
                                <span className="settings-nav-title">{s.title}{dirty[s.id] ? <span className="settings-dirty-dot" title="Unsaved changes" /> : null}</span>
                                <span className="hint settings-nav-blurb">{s.blurb}</span>
                            </span>
                            <span className="settings-nav-chevron" aria-hidden="true">›</span>
                        </Link>
                    ))}
                </nav>
                <div className={`settings-content${active ? '' : ' narrow-hidden'}`}>
                    {settings.isPending && <div className="empty">Loading your settings…</div>}
                    {settings.isError && (
                        <div className="empty">
                            Couldn't load settings: {(settings.error as Error).message}
                            <div><button type="button" className="btn" onClick={() => settings.refetch()}>Try again</button></div>
                        </div>
                    )}
                    {data && !active && (
                        <div className="empty settings-welcome">
                            <div className="empty-title">Everything about how Goobster works with you</div>
                            <p className="hint">Pick a section, or search. Each control says where it applies — your account, your private chats, or just this device. Server-wide settings stay with <code>/</code> commands in each server.</p>
                        </div>
                    )}
                    {data && active === 'profile' && <ProfileSection section={data.sections.profile} onDirty={markDirty('profile')} />}
                    {data && active === 'chat' && <ChatSection section={data.sections.chat} onDirty={markDirty('chat')} />}
                    {data && active === 'voice' && <VoiceSection section={data.sections.voice} capabilities={data.capabilities} onDirty={markDirty('voice')} />}
                    {data && active === 'initiative' && <InitiativeSection section={data.sections.initiative} onDirty={markDirty('initiative')} />}
                    {data && active === 'memory' && <MemorySection section={data.sections.memory} userId={me.user.id} />}
                    {data && active === 'connections' && <ConnectionsSection section={data.sections.connections} />}
                    {data && active === 'appearance' && <AppearanceSection section={data.sections.appearance} onDirty={markDirty('appearance')} />}
                    {data && active === 'account' && <AccountSection section={data.sections.account} />}
                </div>
            </div>
        </main>
    );
}
