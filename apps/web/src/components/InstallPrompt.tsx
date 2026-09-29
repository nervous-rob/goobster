import { useState } from 'react';
import { useToast } from '../hooks/useToast';
import { useInstallPrompt } from '../lib/pwa';

/**
 * "Install Goobster" for Settings → Appearance (documentation/pwa.md).
 * Chromium hands us a prompt to replay; Safari never does, so iOS gets
 * the Share-sheet instructions; an already-installed window says so.
 */
export function InstallPrompt() {
    const toast = useToast();
    const { available, installed, standalone, ios, install } = useInstallPrompt();
    const [busy, setBusy] = useState(false);

    if (standalone) {
        return <div className="hint" data-testid="install-standalone">You are using the installed app. Shortcuts, the badge and notifications all work from here.</div>;
    }
    if (installed) {
        return <div className="hint" data-testid="install-done">Installed. Open Goobster from your home screen, dock or start menu.</div>;
    }
    if (available) {
        return (
            <div className="settings-stack">
                <div>
                    <button type="button" className="btn primary" disabled={busy} data-testid="install-button"
                        onClick={async () => {
                            setBusy(true);
                            const outcome = await install();
                            setBusy(false);
                            if (outcome === 'accepted') toast('Goobster is installing.');
                            else if (outcome === 'unavailable') toast('The browser did not offer an install prompt.', true);
                        }}>
                        {busy ? 'Installing…' : 'Install Goobster'}
                    </button>
                </div>
                <div className="hint">Opens in its own window, gets an icon and an unread badge, and can notify you when a tab is not open.</div>
            </div>
        );
    }
    if (ios) {
        return (
            <div className="hint" data-testid="install-ios">
                In Safari, tap <strong>Share</strong> and then <strong>Add to Home Screen</strong>. The installed app opens full-screen and can receive notifications.
            </div>
        );
    }
    return (
        <div className="hint" data-testid="install-manual">
            Use the browser's <strong>Install</strong> option (the icon at the end of the address bar, or the browser menu) to add Goobster as an app. Firefox needs an extension for this; Chrome, Edge and Safari support it directly.
        </div>
    );
}
