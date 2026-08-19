import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal } from '../components/Modal';

type ConfirmFn = (text: string) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    const [text, setText] = useState<string | null>(null);
    const resolver = useRef<(value: boolean) => void>(() => {});
    const confirm = useCallback<ConfirmFn>((message) => {
        setText(message);
        return new Promise((resolve) => { resolver.current = resolve; });
    }, []);
    const close = (result: boolean) => {
        setText(null);
        resolver.current(result);
    };
    const value = useMemo(() => confirm, [confirm]);
    return (
        <ConfirmContext.Provider value={value}>
            {children}
            {text !== null && (
                <Modal onClose={() => close(false)}>
                    <p id="dialog-text">{text}</p>
                    <div className="modal-actions">
                        <button type="button" className="btn" onClick={() => close(false)}>Cancel</button>
                        <button type="button" className="btn danger" onClick={() => close(true)}>Confirm</button>
                    </div>
                </Modal>
            )}
        </ConfirmContext.Provider>
    );
}

export function useConfirm(): ConfirmFn {
    return useContext(ConfirmContext);
}
