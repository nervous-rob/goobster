import { createContext, useContext, type ReactNode } from 'react';
import { closeConversationDrawer } from '../hooks/useConversationDrawer';

const OpenMenu = createContext<() => void>(() => {});

export function MenuProvider({
    open,
    children
}: {
    open: () => void;
    children: ReactNode;
}) {
    return <OpenMenu.Provider value={open}>{children}</OpenMenu.Provider>;
}

/** Same classes as the legacy client so desktop CSS hides it and mobile CSS shows it. */
export function MenuButton() {
    const open = useContext(OpenMenu);
    return (
        <button type="button" className="icon-action menu-btn" aria-label="Open rooms" onClick={() => {
            closeConversationDrawer();
            open();
        }}>☰</button>
    );
}
