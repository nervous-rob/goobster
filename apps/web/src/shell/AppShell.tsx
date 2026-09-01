import { useCallback, useEffect, useState } from 'react';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { applyAtmosphere } from '../lib/atmosphere';
import { keys } from '../lib/query';
import { useSession } from '../hooks/useSession';
import { usePortalEvents } from '../hooks/usePortalEvents';
import { useToast } from '../hooks/useToast';
import { ForgetModal } from '../components/ForgetModal';
import { useRoomDrawerClose } from '../hooks/useConversationDrawer';
import { MenuProvider } from './MenuButton';

const NAV = [
    { section: 'The house', items: [
        { to: '/', label: '🏠 Home', room: 'home' },
        { to: '/study', label: '💬 Study', room: 'study' },
        { to: '/parlor', label: '🛋️ Parlor', room: 'parlor' },
        { to: '/spitball', label: '🧠 Spitball', room: 'spitball' },
        { to: '/workshop', label: '✨ Workshop', room: 'workshop' },
        { to: '/conservatory', label: '🎹 Conservatory', room: 'conservatory' },
        { to: '/observatory', label: '🔭 Observatory', room: 'observatory', feature: 'observatory' as const }
    ] },
    { section: 'The grounds', items: [
        { to: '/exchange', label: '📊 Exchange', room: 'exchange' },
        { to: '/noticed', label: '🧭 Noticed', room: 'noticed' },
        { to: '/tasks', label: '🗓️ Tasks', room: 'tasks' },
        { to: '/decks', label: '🃏 Decks', room: 'decks' },
        { to: '/usage', label: '📈 Usage', room: 'usage' }
    ] }
];

const PATH_ROOM: Record<string, string> = {
    '/': 'home',
    '/share': 'share',
    '/study': 'study',
    '/parlor': 'parlor',
    '/spitball': 'spitball',
    '/library': 'spitball',
    '/workshop': 'workshop',
    '/conservatory': 'conservatory',
    '/observatory': 'observatory',
    '/exchange': 'exchange',
    '/noticed': 'noticed',
    '/tasks': 'tasks',
    '/decks': 'decks',
    '/usage': 'usage'
};

// The shell tolerates a null session (public share pages render inside it):
// feature-gated rooms hide, the footer offers Sign in, and room links lead
// anonymous viewers to the login gate.
export function AppShell() {
    const me = useSession();
    const toast = useToast();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    const [theme, setTheme] = useState(() => localStorage.getItem('goobster-theme') === 'light' ? 'light' : 'dark');
    const [drawer, setDrawer] = useState(false);
    const [forgetOpen, setForgetOpen] = useState(false);
    const closeRooms = useCallback(() => setDrawer(false), []);
    useRoomDrawerClose(closeRooms);
    usePortalEvents(Boolean(me));

    const room = Object.entries(PATH_ROOM).find(([path]) => pathname === path || pathname.startsWith(`${path}/`))?.[1]
        || (pathname.startsWith('/study') ? 'study' : pathname.startsWith('/parlor') ? 'parlor' : 'home');

    useEffect(() => { applyAtmosphere(room); }, [room]);
    useEffect(() => {
        const open = () => setForgetOpen(true);
        window.addEventListener('goobster-forget', open);
        return () => window.removeEventListener('goobster-forget', open);
    }, []);
    useEffect(() => {
        document.body.classList.toggle('light', theme === 'light');
        localStorage.setItem('goobster-theme', theme);
    }, [theme]);

    useEffect(() => {
        const raw = (window.location.hash || '').replace(/^#/, '');
        if (!raw) return;
        const [name, id] = raw.split('/');
        const map: Record<string, string> = {
            home: '/', study: '/study', parlor: '/parlor', spitball: '/spitball',
            library: '/spitball', workshop: '/workshop', conservatory: '/conservatory',
            observatory: '/observatory',
            exchange: '/exchange', tasks: '/tasks', noticed: '/noticed', decks: '/decks',
            usage: '/usage', chat: '/study', memory: '/spitball', mtga: '/decks'
        };
        const to = map[name];
        if (to) {
            const dest = id && (/^\d+$/.test(id) || name === 'conservatory') ? `${to}/${id}` : to;
            navigate({ to: dest as never, replace: true });
            history.replaceState(null, '', window.location.pathname + window.location.search);
        }
    }, [navigate]);

    async function logout() {
        try { await api.logout(); } catch { /* already out */ }
        await queryClient.invalidateQueries({ queryKey: keys.me });
        window.location.reload();
    }

    return (
        <MenuProvider open={() => setDrawer(true)}>
        <div className="app">
            <div id="sidebar-backdrop" className={`sidebar-backdrop${drawer ? '' : ' hidden'}`} onClick={() => setDrawer(false)} />
            <aside id="sidebar" className={drawer ? 'open' : ''}>
                <div className="sidebar-top">
                    <Link to="/" className={`brand brand-home${room === 'home' ? ' active' : ''}`} onClick={() => setDrawer(false)}>
                        <img className="brand-logo" src="/app/icons/goobster.svg" alt="" width={24} height={24} /> Goobster
                    </Link>
                    <nav className="nav" aria-label="Rooms">
                        {NAV.map((group) => (
                            <div key={group.section}>
                                <div className="nav-section">{group.section}</div>
                                {group.items.map((item) => {
                                    if (item.feature && !me?.features?.[item.feature]) return null;
                                    const active = room === item.room;
                                    return (
                                        <Link key={item.to} to={item.to} className={`nav-btn${active ? ' active' : ''}`}
                                            onClick={() => setDrawer(false)}>
                                            {item.label}
                                        </Link>
                                    );
                                })}
                            </div>
                        ))}
                    </nav>
                </div>
                <div className="sidebar-footer">
                    <button type="button" className="btn subtle" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
                        {theme === 'light' ? '☀️ Theme' : '🌙 Theme'}
                    </button>
                    {me ? (
                        <>
                            <div className="user-chip">
                                {me.user.avatar && <img className="avatar" src={me.user.avatar} alt="" />}
                                <span>{me.user.name || me.user.id}</span>
                            </div>
                            <button type="button" className="btn subtle" onClick={logout}>Log out</button>
                        </>
                    ) : (
                        <Link to="/" className="btn subtle" onClick={() => setDrawer(false)}>Sign in</Link>
                    )}
                </div>
            </aside>
            <div id="stage">
                <Outlet />
            </div>
            {forgetOpen && <ForgetModal onClose={() => setForgetOpen(false)} toast={toast} />}
        </div>
        </MenuProvider>
    );
}

export function useForgetOpener(): () => void {
    return () => {
        const event = new CustomEvent('goobster-forget');
        window.dispatchEvent(event);
    };
}
