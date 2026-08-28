import { Suspense } from 'react';
import { Outlet } from '@tanstack/react-router';
import { MenuButton } from '../shell/MenuButton';
import { SiteNav } from './components/shared/SiteNav';
import './styles/rhythm.css';
import './styles/globals.css';
import './styles/harmony.css';
import './styles/space.css';
import './styles/melody.css';
import './styles/stage.css';
import './styles/studio.css';

export function ConservatoryLayout() {
    return (
        <main className="pane next-pane is-in conservatory" id="pane-conservatory">
            <div className="conservatory-toolbar">
                <MenuButton />
                <div className="chat-title">Conservatory</div>
                <SiteNav />
            </div>
            <div className="conservatory-body">
                <Suspense fallback={<div className="empty">Warming the lab…</div>}>
                    <Outlet />
                </Suspense>
            </div>
        </main>
    );
}
