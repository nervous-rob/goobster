import { Component, type ErrorInfo, type ReactNode } from 'react';
import { isChunkLoadError, reloadOnce } from '../lib/pwa';

type State = { error: Error | null; reloading: boolean };

/**
 * The last line of stale-chunk recovery (documentation/pwa.md): a lazy
 * route whose hashed chunk vanished with a deploy reloads the page once;
 * anything else - or a second failure inside a minute - shows a plain
 * message with a Reload button instead of a blank stage.
 */
export class ChunkErrorBoundary extends Component<{ children: ReactNode }, State> {
    state: State = { error: null, reloading: false };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo): void {
        if (isChunkLoadError(error) && reloadOnce()) {
            this.setState({ reloading: true });
            return;
        }
        console.error('Portal render failed', error, info.componentStack);
    }

    render(): ReactNode {
        const { error, reloading } = this.state;
        if (!error) return this.props.children;
        return (
            <main className="pane next-pane is-in">
                <div className="empty" role="alert">
                    {reloading ? (
                        <p>Goobster was updated - reloading…</p>
                    ) : (
                        <>
                            <p>{isChunkLoadError(error)
                                ? 'Part of the app could not be loaded. You may be offline, or Goobster was just updated.'
                                : 'Something went wrong drawing this room.'}</p>
                            <button type="button" className="btn primary" onClick={() => window.location.reload()}>Reload</button>
                        </>
                    )}
                </div>
            </main>
        );
    }
}
