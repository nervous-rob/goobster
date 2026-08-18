# web-ui (not started)

Future Svelte 5 + Vite SPA for the house. See
`documentation/reactive_web_architecture.md` §9.

Do not scaffold this tree until Phase 3. The live client is still
`web/app/` (vanilla ES modules). This directory exists so the spec,
the Docker image, and the port have a single agreed home.

When it starts:

- `base: '/app/'` in Vite
- consume `/api/app` unchanged — never a second chat pipeline
- move `markdown.js` / `highlight.js` / `math.js` / `graph.js` /
  `codeblocks.js` / `atmosphere.js` rather than rewriting them
- hash rooms stay `#home`, `#study`, `#parlor`, `#library`, …
- service worker still never intercepts `/api/*`
