import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

type ToastFn = (message: string, isError?: boolean) => void;

const ToastContext = createContext<ToastFn>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
    const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
    const timer = useRef<number | null>(null);
    const show = useCallback<ToastFn>((message, isError = false) => {
        setToast({ message, error: isError });
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setToast(null), 4000);
    }, []);
    const value = useMemo(() => show, [show]);
    return (
        <ToastContext.Provider value={value}>
            {children}
            {toast && (
                <div id="toast" className={toast.error ? 'error' : ''} role="status">
                    {toast.message}
                </div>
            )}
        </ToastContext.Provider>
    );
}

export function useToast(): ToastFn {
    return useContext(ToastContext);
}
