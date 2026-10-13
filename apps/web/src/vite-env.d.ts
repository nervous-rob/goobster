/// <reference types="vite/client" />

interface Window {
    katex?: {
        render: (tex: string, node: HTMLElement, opts: Record<string, unknown>) => void;
    };
}

/** Inlined by vite.config.ts / vite.setup.config.ts from apps/web/brand.config.cjs. */
declare const __PRODUCT_NAME__: string | undefined;
