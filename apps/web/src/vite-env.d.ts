/// <reference types="vite/client" />

interface Window {
    katex?: {
        render: (tex: string, node: HTMLElement, opts: Record<string, unknown>) => void;
    };
}
