import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import {
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
import { HomeRoom } from './rooms/HomeRoom';
import { StudyRoom } from './rooms/StudyRoom';
import { LibraryRoom } from './rooms/LibraryRoom';
import { TasksRoom } from './rooms/TasksRoom';
import { NoticedRoom } from './rooms/NoticedRoom';
import { UsageRoom } from './rooms/UsageRoom';
import { WorkshopRoom } from './rooms/WorkshopRoom';
import { DecksRoom } from './rooms/DecksRoom';
import { ExchangeRoom } from './rooms/ExchangeRoom';
import { ParlorRoom } from './rooms/ParlorRoom';
import { ObservatoryRoom } from './rooms/ObservatoryRoom';
import './styles.css';

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
            <Gate />
        </Providers>
    ),
});

const appRoute = createRoute({
    getParentRoute: () => rootRoute,
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

const libraryRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/library',
    component: LibraryRoom,
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

const usageRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/usage',
    component: UsageRoom,
});

const workshopRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/workshop',
    component: WorkshopRoom,
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

const routeTree = rootRoute.addChildren([
    appRoute.addChildren([
        indexRoute,
        studyRoute,
        studyIdRoute,
        libraryRoute,
        tasksRoute,
        noticedRoute,
        usageRoute,
        workshopRoute,
        decksRoute,
        exchangeRoute,
        parlorRoute,
        parlorIdRoute,
        observatoryRoute,
        observatoryGraphRoute,
        observatorySearchRoute,
        observatoryPeopleRoute,
        observatoryEventsRoute,
    ]),
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
