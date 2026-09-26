import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useParams, useRouterState } from '@tanstack/react-router';
import corpus from 'virtual:goobster-docs';
import search from './search.cjs';
import { MenuButton } from '../shell/MenuButton';
import './documentation.css';

const byId = new Map(corpus.pages.map((page) => [page.id, page]));

export function Documentation() {
    const { slug } = useParams({ strict: false }) as { slug?: string };
    const page = byId.get(slug || 'getting-started');
    const location = useRouterState({ select: (state) => state.location });
    const navigate = useNavigate();
    const [query, setQuery] = useState('');
    const [browse, setBrowse] = useState(false);
    const contentRef = useRef<HTMLElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    const browseRef = useRef<HTMLButtonElement>(null);
    const results = useMemo(() => search.searchDocumentation(corpus.pages, query), [query]);

    useEffect(() => {
        document.title = `${page?.title || 'Page not found'} · Goobster Documentation`;
        return () => { document.title = 'Goobster'; };
    }, [page]);

    useEffect(() => {
        setBrowse(false);
        setQuery('');
        const content = contentRef.current;
        if (!content) return;
        let hash = location.hash.replace(/^#/, '');
        try { hash = decodeURIComponent(hash); } catch { /* use the literal fragment */ }
        // Lookup by id, not by CSS selector: copied fragments may contain punctuation.
        const target = hash ? Array.from(content.querySelectorAll<HTMLElement>('[id]')).find((el) => el.id === hash) : null;
        if (target) {
            target.scrollIntoView({ block: 'start', behavior: 'instant' });
            target.focus({ preventScroll: true });
        } else {
            content.scrollTop = 0;
            content.focus({ preventScroll: true });
        }
    }, [slug, location.hash]);

    function articleLink(event: MouseEvent<HTMLElement>) {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]');
        if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
        const url = new URL(link.href, window.location.href);
        if (url.origin !== window.location.origin || !url.pathname.startsWith('/app/')) return;
        event.preventDefault();
        void navigate({ to: `${url.pathname.slice(4)}${url.search}${url.hash}` as never });
    }

    return (
        <main className="pane next-pane is-in docs-pane" id="pane-docs">
            <header className="pane-header">
                <div className="title-row"><MenuButton /><h1>Documentation</h1></div>
                <button ref={browseRef} type="button" className="btn docs-browse"
                    aria-expanded={browse} aria-controls="docs-navigation" onClick={() => setBrowse(!browse)}>
                    {browse ? 'Close documentation menu' : 'Browse documentation'}
                </button>
            </header>
            <div className="docs-layout">
                <aside id="docs-navigation" className={`docs-sidebar${browse ? ' is-open' : ''}`}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') { setBrowse(false); browseRef.current?.focus(); }
                    }}>
                    <a className="docs-skip" href="#docs-article" onClick={(event) => {
                        event.preventDefault(); setBrowse(false); contentRef.current?.focus();
                    }}>Skip to article</a>
                    <div className="docs-search">
                        <label htmlFor="docs-search">Search documentation</label>
                        <input ref={searchRef} id="docs-search" className="input" type="search" maxLength={200}
                            placeholder="Search guides and sections…" value={query} onChange={(event) => setQuery(event.target.value)} />
                    </div>
                    {query.trim() ? (
                        <section className="docs-results" aria-label="Documentation search results">
                            <p className="hint" role="status">{results.length ? `${results.length === 30 ? 'Top 30' : results.length} matching sections` : 'No matching sections. Try a feature name or a shorter phrase.'}</p>
                            {results.map((result) => (
                                <Link key={`${result.pageId}#${result.anchor}`} className="docs-result" to="/docs/$slug"
                                    params={{ slug: result.pageId }} hash={result.anchor}
                                    onClick={() => { setQuery(''); setBrowse(false); }}>
                                    <strong>{result.title}</strong>
                                    <span>{result.heading}</span>
                                    {result.excerpt && <small>{result.excerpt}</small>}
                                </Link>
                            ))}
                            <button type="button" className="btn subtle" onClick={() => { setQuery(''); searchRef.current?.focus(); }}>Clear search</button>
                        </section>
                    ) : (
                        <nav aria-label="Documentation contents">
                            {corpus.groups.map((group) => (
                                <section key={group.title} className="docs-group">
                                    <h2>{group.title}</h2>
                                    <ul>{group.ids.map((id) => {
                                        const item = byId.get(id)!;
                                        const current = item.id === page?.id;
                                        return <li key={id}>
                                            <Link to="/docs/$slug" params={{ slug: id }} aria-current={current ? 'page' : undefined}
                                                className="docs-page-link" onClick={() => setBrowse(false)}>{item.title}</Link>
                                            {current && <ul className="docs-sections">
                                                {item.headings.filter((heading) => heading.level > 1).map((heading) => (
                                                    <li key={heading.anchor} style={{ paddingInlineStart: `${Math.min(heading.level - 2, 3) * 10}px` }}>
                                                        <Link to="/docs/$slug" params={{ slug: id }} hash={heading.anchor}
                                                            activeOptions={{ exact: true, includeHash: true }}
                                                            onClick={() => setBrowse(false)}>{heading.title}</Link>
                                                    </li>
                                                ))}
                                            </ul>}
                                        </li>;
                                    })}</ul>
                                </section>
                            ))}
                        </nav>
                    )}
                </aside>
                <article ref={contentRef} className="docs-article" id="docs-article" tabIndex={-1} aria-label={page?.title || 'Page not found'}
                    onClick={articleLink}>
                    {page ? <div className="docs-reading">
                        <div className="docs-breadcrumb">{page.group} <span aria-hidden="true">/</span> {page.title}</div>
                        <div className="md-body docs-markdown" dangerouslySetInnerHTML={{ __html: page.html }} />
                        <footer className="docs-source">
                            <a href={page.sourceUrl} target="_blank" rel="noopener noreferrer">View Markdown source ↗</a>
                            <span>{corpus.revision ? `Source revision ${corpus.revision.slice(0, 8)}` : 'Documentation included in this web build'}</span>
                        </footer>
                    </div> : <div className="docs-reading">
                        <h2>Page not found</h2><p>This documentation page is not included in this version of Goobster.</p>
                        <Link to="/docs/$slug" params={{ slug: 'getting-started' }}>Open Getting started</Link>
                    </div>}
                </article>
            </div>
        </main>
    );
}
