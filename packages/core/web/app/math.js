/**
 * LaTeX typesetting for chat bubbles. markdown.js emits placeholder
 * spans (`.math`, TeX source in data-tex and as visible text); this module
 * upgrades them with KaTeX, which is served locally from
 * /app/vendor/katex (no CDN - self-hosted first). The library is loaded
 * lazily on the first message that actually contains math, and when it
 * can't load the escaped TeX source simply stays visible.
 */

let katexPromise = null;

function loadKatex() {
    if (window.katex) return Promise.resolve(window.katex);
    if (!katexPromise) {
        katexPromise = new Promise((resolve) => {
            // Absolute paths: this module is also used by the share viewer,
            // which lives at the nested /app/share/<token> URL.
            const css = document.createElement('link');
            css.rel = 'stylesheet';
            css.href = '/app/vendor/katex/katex.min.css';
            document.head.appendChild(css);

            const script = document.createElement('script');
            script.src = '/app/vendor/katex/katex.min.js';
            script.onload = () => resolve(window.katex || null);
            script.onerror = () => resolve(null);
            document.head.appendChild(script);
        });
    }
    return katexPromise;
}

/**
 * Typeset every un-rendered math placeholder under root. Safe to call
 * repeatedly (streaming re-renders); already-typeset spans are skipped.
 * @param {HTMLElement} root
 */
export function renderMathIn(root) {
    if (!root) return;
    const nodes = root.querySelectorAll('.math:not([data-typeset])');
    if (nodes.length === 0) return;
    loadKatex().then((katex) => {
        if (!katex) return;
        for (const node of nodes) {
            const tex = node.dataset.tex;
            if (!tex) continue;
            try {
                katex.render(tex, node, {
                    displayMode: node.classList.contains('math-display'),
                    throwOnError: false,
                    // Chat content is untrusted; \href etc. stay disabled.
                    trust: false,
                    strict: 'ignore'
                });
                node.dataset.typeset = '1';
            } catch {
                // Malformed TeX: the escaped source text stays visible.
            }
        }
    });
}
