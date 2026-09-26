---
title: Documentation wiki
kind: guide
summary: How the public in-app documentation, section navigation, and local search are built from selected repository Markdown.
tags: [documentation, wiki, portal, build]
---

# Documentation wiki

The portal's **Documentation** link opens `/app/docs/getting-started`. `/app/docs` redirects there. The documentation is public, including before sign-in, and contains only selected, shipped repository files. It works with Discord and AI providers disabled.

## Reading and searching

The left column contains search and a grouped contents list. Selecting an article reveals its heading hierarchy. Every heading has a fragment identifier derived from its text, including repeated headings; search results link to a matching section. Renaming a heading changes its fragment. Browser Back, Forward, reload, and copied links preserve the article and section.

Search ranks all query words against article titles, heading breadcrumbs, and section bodies. It is case-insensitive, understands configuration-style identifiers, and runs entirely in the browser. It does not query personal notes, the database, a provider, or a remote search service.

On narrow screens, **Browse documentation** opens the contents in place of the article. Choosing a link or pressing Escape closes it. Navigation and results are ordinary keyboard-accessible links. The page uses the portal theme and respects reduced motion.

## Publishing

Edit the existing Markdown source. `apps/web/docs/manifest.json` selects the public files and sets their navigation labels and order. Add a page there deliberately; drafts and old implementation plans are not automatically published.

`apps/web/docs/build.cjs` compiles those files through the Vite documentation plugin. `npm run build:web` includes the generated pages and section search index in the lazy documentation bundle. `npm run dev:web` watches the selected files. No generated copy is checked in. Docker's web stage copies these sources before building.

The build fails on invalid front matter, duplicate ids or paths, missing sources, and sources outside `README.md` or `documentation/`. Symlinks are rejected. Runtime `selfDocs.sources`, `data/self-docs/`, configuration files, and database content are never inputs.

## Rendering and links

Markdown is compiled with raw HTML disabled. Dangerous URL schemes are rejected. Relative links to published articles are rewritten to their wiki address; other repository links go to the source revision on GitHub. External links open separately with `noopener noreferrer`. Code is displayed, never executed. Mermaid fences remain readable source code.

The docs are a snapshot of the web build. Rebuild and deploy after editing their sources. A source link and revision appear on each article. `consultDocs` keeps its existing runtime seeding and permissions; its corpus also contains documents not selected for this reader.

## Validation

`tests/documentationWiki.test.js` checks source restrictions, rendering safety, link rewriting, anchors, the real manifest, and search. `e2e/documentation.spec.js` exercises anonymous access, the app entry point, search, section links, history, unknown pages, and narrow-screen keyboard navigation. Run these with the normal typecheck, web build, docs check, and test inventory check.
