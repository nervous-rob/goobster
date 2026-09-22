import { lazy, StrictMode, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
    Navigate,
    Outlet,
    RouterProvider,
    createRootRoute,
    createRoute,
    createRouter,
    useParams,
    useRouterState,
} from '@tanstack/react-router';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from './lib/query';
import { SessionProvider, useSession } from './hooks/useSession';
import { ToastProvider } from './hooks/useToast';
import { ConfirmProvider } from './hooks/useConfirm';
import { TutorialProvider } from './tutorials/TutorialProvider';
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
import { KnowledgeRoom } from './rooms/knowledge/KnowledgeRoom';
import { NotesView } from './rooms/knowledge/NotesView';
import { MapView } from './rooms/knowledge/MapView';
import { ResearchView } from './rooms/knowledge/ResearchView';
import { TasksRoom } from './rooms/TasksRoom';
import { NoticedRoom } from './rooms/NoticedRoom';
import { InboxRoom } from './rooms/InboxRoom';
import { UsageRoom } from './rooms/UsageRoom';
import { DecksRoom } from './rooms/DecksRoom';
import { ExchangeRoom } from './rooms/ExchangeRoom';
import { ParlorRoom } from './rooms/ParlorRoom';
import { ProjectListView } from './rooms/projects/ProjectListView';
import { ProjectResolver } from './rooms/projects/ProjectResolver';
import { ProjectShell } from './rooms/projects/ProjectShell';
import { ActivityRoom } from './rooms/ActivityRoom';
import { ToolsRoom } from './rooms/ToolsRoom';
import { SettingsRoom } from './rooms/settings/SettingsRoom';
import { canonicalPath } from './lib/rooms';
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
                    <SessionProvider>
                        <TutorialProvider>{children}</TutorialProvider>
                    </SessionProvider>
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

// --- Canonical destinations (documentation/portal_navigation.md) ----------
// Seven primary rooms plus the account area. Route ids stay explicit so
// params keep their validation; names and aliases come from lib/rooms.

const chatRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/chat',
    component: StudyRoom,
});

const chatIdRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/chat/$conversationId',
    component: StudyRoom,
});

// Knowledge opens on Notes; Map and Research are registered views of the
// same room (lib/rooms.cjs). The bare path redirects with search and hash
// intact so a bookmarked `/knowledge?…` keeps its state.
const knowledgeRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/knowledge',
    component: KnowledgeRoom,
});

const knowledgeIndexRoute = createRoute({
    getParentRoute: () => knowledgeRoute,
    path: '/',
    component: () => <Navigate to="/knowledge/notes" search={true} hash={true} replace />,
});

const knowledgeNotesRoute = createRoute({
    getParentRoute: () => knowledgeRoute,
    path: '/notes',
    component: NotesView,
});

const knowledgeMapRoute = createRoute({
    getParentRoute: () => knowledgeRoute,
    path: '/map',
    component: MapView,
});

const knowledgeResearchRoute = createRoute({
    getParentRoute: () => knowledgeRoute,
    path: '/research',
    component: ResearchView,
});

// Projects: the list, a slug-only resolver, and one project addressed by
// its owner and slug on a registered view (lib/rooms.cjs `detail`). Two
// owners may share a slug, so the owner is part of the address; the bare
// detail path redirects to Overview with search and hash intact.
const projectsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/projects',
    component: ProjectListView,
});

const projectResolverRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/projects/$slug',
    component: ProjectResolver,
});

function ProjectDefaultView() {
    const { owner, slug } = useParams({ strict: false }) as { owner: string; slug: string };
    return <Navigate to={`/projects/${owner}/${slug}/overview` as never} search={true} hash={true} replace />;
}

const projectDetailRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/projects/$owner/$slug',
    component: ProjectDefaultView,
});

const projectViewRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/projects/$owner/$slug/$view',
    component: ProjectShell,
});

const discussionsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/discussions',
    component: ParlorRoom,
});

const discussionsIdRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/discussions/$conversationId',
    component: ParlorRoom,
});

// Activity keeps delivery (Inbox), proactive attention, and scheduling as
// three views with their own actions and state - one destination, not one
// merged list.
const activityRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/activity',
    component: ActivityRoom,
});

const activityIndexRoute = createRoute({
    getParentRoute: () => activityRoute,
    path: '/',
    component: () => <Navigate to="/activity/inbox" replace />,
});

const activityInboxRoute = createRoute({
    getParentRoute: () => activityRoute,
    path: '/inbox',
    component: InboxRoom,
});

const activityAttentionRoute = createRoute({
    getParentRoute: () => activityRoute,
    path: '/attention',
    component: NoticedRoom,
});

const activityScheduledRoute = createRoute({
    getParentRoute: () => activityRoute,
    path: '/scheduled',
    component: TasksRoom,
});

const toolsRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/tools',
    component: ToolsRoom,
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

// --- Legacy aliases --------------------------------------------------------
// Bookmarks, stored Inbox links, notification deep links, and settings
// return locations written before the rename keep their meaning: the path
// is rewritten through the registry and the resource id, query string and
// hash travel with it. Each alias is its own typed route so a conversation
// id is still validated as a param rather than swallowed by a splat.
function LegacyRedirect() {
    const pathname = useRouterState({ select: (s) => s.location.pathname });
    return <Navigate to={canonicalPath(pathname) as never} search={true} hash={true} replace />;
}

const legacyAlias = (path: string) => createRoute({
    getParentRoute: () => appRoute,
    path,
    component: LegacyRedirect,
});

const legacyRoutes = [
    '/study', '/study/$conversationId',
    '/spitball', '/spitball/$view', '/library', '/library/$view',
    '/observatory', '/observatory/graph', '/observatory/search', '/observatory/people', '/observatory/events',
    '/workshop',
    '/parlor', '/parlor/$conversationId',
    '/inbox', '/noticed', '/attention', '/tasks'
].map(legacyAlias);

const routeTree = rootRoute.addChildren([
    shareShellRoute.addChildren([shareRoute]),
    inviteRoute,
    recoverRoute,
    registerRoute,
    forgotRoute,
    verifyEmailRoute,
    authedRoute.addChildren([appRoute.addChildren([
        indexRoute,
        chatRoute,
        chatIdRoute,
        knowledgeRoute.addChildren([
            knowledgeIndexRoute,
            knowledgeNotesRoute,
            knowledgeMapRoute,
            knowledgeResearchRoute,
        ]),
        projectsRoute,
        projectResolverRoute,
        projectDetailRoute,
        projectViewRoute,
        discussionsRoute,
        discussionsIdRoute,
        activityRoute.addChildren([
            activityIndexRoute,
            activityInboxRoute,
            activityAttentionRoute,
            activityScheduledRoute,
        ]),
        toolsRoute,
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
        exchangeRoute,
        decksRoute,
        usageRoute,
        hostRoute,
        settingsRoute,
        settingsSectionRoute,
        ...legacyRoutes,
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
