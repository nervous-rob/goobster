import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useToast } from '../hooks/useToast';
import { INSTALL_FIELD_ID, useInstallPrompt } from '../lib/pwa';

/**
 * One click to install, wherever it is placed (documentation/pwa.md).
 * With a captured prompt the click installs on the spot; otherwise it
 * leads to Settings → Appearance, where the iOS / browser-menu
 * instructions live. Renders nothing once the app is installed.
 */
export function useInstallAction(onNavigate?: () => void): { busy: boolean; run: () => Promise<void> } {
    const toast = useToast();
    const navigate = useNavigate();
    const { available, install } = useInstallPrompt();
    const [busy, setBusy] = useState(false);
    return {
        busy,
        run: async () => {
            if (!available) {
                onNavigate?.();
                navigate({ to: '/settings/$section', params: { section: 'appearance' }, hash: INSTALL_FIELD_ID });
                return;
            }
            setBusy(true);
            const outcome = await install();
            setBusy(false);
            if (outcome === 'accepted') toast('Goobster is installing.');
            else if (outcome === 'unavailable') toast('The browser did not offer an install prompt.', true);
        }
    };
}

export function InstallEntry({ onNavigate, className = 'nav-btn', role }: {
    onNavigate?: () => void;
    className?: string;
    role?: string;
}) {
    const { done } = useInstallPrompt();
    const action = useInstallAction(onNavigate);
    if (done) return null;
    return (
        <button type="button" className={`${className} install-entry`} role={role} data-testid="install-nav"
            disabled={action.busy} title="Install Goobster as an app on this device" onClick={() => void action.run()}>
            <span aria-hidden="true">📲</span> {action.busy ? 'Installing…' : 'Install app'}
        </button>
    );
}

/**
 * The shell's one-time nudge: shown when the browser can install with a
 * tap (Chromium prompt captured) or a sheet (iOS Safari), until the
 * person installs or snoozes it for a month.
 */
export function InstallBanner({ onNavigate }: { onNavigate?: () => void }) {
    const { nudge, ios, available, dismissNudge } = useInstallPrompt();
    const action = useInstallAction(onNavigate);
    if (!nudge) return null;
    return (
        <div className="instance-banner install-banner" role="status" data-testid="install-banner">
            <span>
                📲 <strong>Install Goobster as an app.</strong>
                {ios && !available
                    ? ' Add it to your Home Screen for full-screen use and notifications.'
                    : ' Own window, an unread badge on the icon, and notifications when no tab is open.'}
            </span>
            <span className="banner-actions">
                <button type="button" className="btn small primary" disabled={action.busy} data-testid="install-banner-install"
                    onClick={() => void action.run()}>
                    {action.busy ? 'Installing…' : available ? 'Install' : 'Show me how'}
                </button>
                <button type="button" className="btn small subtle" data-testid="install-banner-dismiss" onClick={dismissNudge}>Not now</button>
            </span>
        </div>
    );
}
