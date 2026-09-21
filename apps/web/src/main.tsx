import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Navigate,
    Outlet,
    RouterProvider,
    createRootRoute,
    createRoute,
    createRouter,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query';
import { SessionProvider, useSession } from './hooks/useSession';
import { ToastProvider } from './hooks/useToast';
import { ConfirmProvider } from './hooks/useConfirm';
import { AppShell } from './shell/AppShell';
import { Login } from './shell/Login';
import { InvitePage } from './shell/InvitePage';
import { RecoverPage } from './shell/RecoverPage';
import { RegisterPage } from './shell/RegisterPage';
import { ForgotPage } from './shell/ForgotPage';
import { VerifyEmailPage } from './shell/VerifyEmailPage';
import { HostRoom } from './rooms/HostRoom';
import { SharePage } from './rooms/SharePage';
import { HomeRoom } from './rooms/HomeRoom';
import { StudyRoom } from './rooms/StudyRoom';
import { SpitballRoom } from './rooms/SpitballRoom';
import { TasksRoom } from './rooms/TasksRoom';
import { NoticedRoom } from './rooms/NoticedRoom';
import { InboxRoom } from './rooms/InboxRoom';
import { UsageRoom } from './rooms/UsageRoom';
import { DecksRoom } from './rooms/DecksRoom';
import { ExchangeRoom } from './rooms/ExchangeRoom';
import { ParlorRoom } from './rooms/ParlorRoom';
import { ObservatoryRoom } from './rooms/ObservatoryRoom';
import { SettingsRoom } from './rooms/settings/SettingsRoom';
import './styles.css';

const ConservatoryLayout = lazy(() => import('./music-lab/ConservatoryLayout').then((m) => ({ default: m.ConservatoryLayout })));
const ConservatoryHome = lazy(() => import('./music-lab/ConservatoryHome').then((m) => ({ default: m.ConservatoryHome })));
const IntervalExplorer = lazy(() => import('./music-lab/components/intervals/IntervalExplorer').then((m) => ({ default: m.IntervalExplorer })));
const ChordWorkbench = lazy(() => import('./music-lab/components/chords/ChordWorkbench').then((m) => ({ default: m.ChordWorkbench })));
const RhythmEngineLoader = lazy(() => import('./music-lab/components/rhythm/RhythmEngineLoader').then((m) => ({ default: m.RhythmEngineLoader })));
const HarmonyEngineLoader = lazy(() => import('./music-lab/components/harmony/HarmonyEngineLoader').then((m) => ({ default: m.HarmonyEngineLoader })));
const SpaceEngineLoader = lazy(() => import('./music-lab/components/space/SpaceEngineLoader').then((m) => ({ default: m.SpaceEngineLoader })));
const MelodyEngineLoader = lazy(() => import('./music-lab/components/melody/MelodyEngineLoader').then((m) => ({ default: m.MelodyEngineLoader })));
const StageEngineLoader = lazy(() => import('./music-lab/components/stage/StageEngineLoader').then((m) => ({ default: m.StageEngineLoader })));
const StudioEngineLoader = lazy(() => import('./music-lab/components/studio/StudioEngineLoader').then((m) => ({ default: m.StudioEngineLoader })));

function ConservatoryGate() {
    return (
        <Suspense fallback={<main className="pane next-pane is-in"><div className="empty">Opening the Conservatory…</div></main>}>
            <ConservatoryLayout />
        </Suspense>
    );
}

function Providers({ children }: { children: ReactNode }) {
    return (
        <QueryClientProvider client={queryClient}>
            <ToastProvider>
                <ConfirmProvider>
                    <SessionProvider>{children}</SessionProvider>
                </ConfirmProvider>
            </ToastProvider>
        </QueryClientProvider>
    );
}

function Gate() {
    const me = useSession();
    if (!me) return <Login />;
    return <Outlet />;
}

const rootRoute = createRootRoute({
    component: () => (
        <Providers>
            <Outlet />
        </Providers>
    ),
});

// Public share pages render inside the full app shell (sidebar + room nav)
// but outside the login gate: the unguessable token is the only capability
// needed to READ the share, and the shell tolerates a null session (room
// links land anonymous viewers on the login screen).
const shareShellRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'share-shell',
    component: AppShell,
});

const shareRoute = createRoute({
    getParentRoute: () => shareShellRoute,
    path: '/share/$token',
    component: SharePage,
});

// Invitation and password-reset landing pages are public by design: the
// token in the query string is the only capability they need.
const inviteRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/invite',
    component: InvitePage,
});

const recoverRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/recover',
    component: RecoverPage,
});

// Email-backed entry points: open sign-up, "forgot password", and the
// verification landing page. The server hides them when mail is off.
const registerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/register',
    component: RegisterPage,
});

const forgotRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/forgot',
    component: ForgotPage,
});

const verifyEmailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/verify-email',
    component: VerifyEmailPage,
});

// Everything else lives behind the login gate.
const authedRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'authed',
    component: Gate,
});

const appRoute = createRoute({
    getParentRoute: () => authedRoute,
    id: 'app',
    component: AppShell,
});

const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/',
    component: HomeRoom,
});

const studyRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/study',
    component: StudyRoom,
});

const studyIdRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/study/$conversationId',
    component: StudyRoom,
});

const spitballRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/spitball',
    component: SpitballRoom,
});

// The Library became Spitball; old links and bookmarks keep working.
const libraryRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/library',
    component: () => <Navigate to="/spitball" replace />,
});

const tasksRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/tasks',
    component: TasksRoom,
});

const noticedRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/noticed',
    component: NoticedRoom,
});

const inboxRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/inbox',
    component: InboxRoom,
});

const hostRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/host',
    component: HostRoom,
});

const usageRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/usage',
    component: UsageRoom,
});

const workshopRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/workshop',
    component: () => <Navigate to="/observatory" replace />,
});

const decksRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/decks',
    component: DecksRoom,
});

const exchangeRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/exchange',
    component: ExchangeRoom,
});

const parlorRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/parlor',
    component: ParlorRoom,
});

const parlorIdRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/parlor/$conversationId',
    component: ParlorRoom,
});

const conservatoryRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/conservatory',
    component: ConservatoryGate,
});

const conservatoryIndexRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/',
    component: ConservatoryHome,
});

const conservatoryIntervalsRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/intervals',
    component: IntervalExplorer,
});

const conservatoryChordsRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/chords',
    component: ChordWorkbench,
});

const conservatoryRhythmRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/rhythm',
    component: RhythmEngineLoader,
});

const conservatoryHarmonyRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/harmony',
    component: HarmonyEngineLoader,
});

const conservatorySpaceRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/space',
    component: SpaceEngineLoader,
});

const conservatoryMelodyRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/melody',
    component: MelodyEngineLoader,
});

const conservatoryStageRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/stage',
    component: StageEngineLoader,
});

const conservatoryStudioRoute = createRoute({
    getParentRoute: () => conservatoryRoute,
    path: '/studio',
    component: StudioEngineLoader,
});

const observatoryRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/observatory',
    component: ObservatoryRoom,
});

const observatoryGraphRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/observatory/graph',
    component: ObservatoryRoom,
});

const observatorySearchRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/observatory/search',
    component: ObservatoryRoom,
});

const observatoryPeopleRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/observatory/people',
    component: ObservatoryRoom,
});

const observatoryEventsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/observatory/events',
    component: ObservatoryRoom,
});

const settingsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/settings',
    component: SettingsRoom,
});

const settingsSectionRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/settings/$section',
    component: SettingsRoom,
});

const routeTree = rootRoute.addChildren([
    shareShellRoute.addChildren([shareRoute]),
    inviteRoute,
    recoverRoute,
    registerRoute,
    forgotRoute,
    verifyEmailRoute,
    authedRoute.addChildren([appRoute.addChildren([
        indexRoute,
        hostRoute,
        studyRoute,
        studyIdRoute,
        spitballRoute,
        libraryRoute,
        tasksRoute,
        noticedRoute,
        inboxRoute,
        usageRoute,
        workshopRoute,
        conservatoryRoute.addChildren([
            conservatoryIndexRoute,
            conservatoryIntervalsRoute,
            conservatoryChordsRoute,
            conservatoryRhythmRoute,
            conservatoryHarmonyRoute,
            conservatorySpaceRoute,
            conservatoryMelodyRoute,
            conservatoryStageRoute,
            conservatoryStudioRoute,
        ]),
        decksRoute,
        exchangeRoute,
        parlorRoute,
        parlorIdRoute,
        observatoryRoute,
        observatoryGraphRoute,
        observatorySearchRoute,
        observatoryPeopleRoute,
        observatoryEventsRoute,
        settingsRoute,
        settingsSectionRoute,
    ])]),
]);

const router = createRouter({
    routeTree,
    basepath: '/app',
    defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
    interface Register {
        router: typeof router;
    }
}

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(() => { /* optional */ });
}

const el = document.getElementById('root');
if (!el) throw new Error('#root missing');
createRoot(el).render(
    <StrictMode>
        <RouterProvider router={router} />
    </StrictMode>
);
