# Split deploy (bot / api / web)

Optional Docker topology for the architecture in
`documentation/reactive_web_architecture.md`.

The root `Dockerfile` + `docker-compose.yml` remain the supported
one-container path. Use this directory when you want the house UI
served as its own container, or (later) a Discord process that does
not share an event loop with the browser API.

## What works today

`docker-compose.yml` in this folder is **proxy mode**:

- `core` — today's all-in-one image (`Dockerfile` at the repo root)
- `web` — nginx on port 3000: static `/app/`, API and WebSockets
  proxied to `core`

This does **not** yet split the Node process. It proves the front
door: the browser talks to nginx, cookies stay same-origin, and a
future Svelte build can drop into `Dockerfile.web` without touching
Discord.

```bash
# from the repo root, with config.json present
docker compose -f deploy/split/docker-compose.yml up --build
# house: http://localhost:3000/app/
# health: http://localhost:3000/health
```

Set `webapp.enabled` / `webapp.devMode` in `config.json` the same way
you would for the single-container deploy.

## Target split (do not run yet)

`docker-compose.split.yml` is the Phase 2 contract: `bot` + `api` +
`web` + `proxy`, same SQLite volume, internal RPC on the compose
network. It requires `GOOBSTER_ROLE` and the bot RPC from the spec.
Starting it today would launch **two** full `index.js` processes on
one bot token — duplicate heartbeats, duplicate automations, a
split gateway. Do not.

```bash
# only after Phase 2 lands
docker compose -f deploy/split/docker-compose.split.yml up --build
```

## SQLite volume

`./data` must be a local POSIX filesystem. WAL + `mmap` across NFS
or a networked bind mount will corrupt the database.

## After the Svelte port

Change `Dockerfile.web` to copy `web-ui/dist` instead of `web/app`,
and keep KaTeX under `/app/vendor/katex` (see the spec). The proxy
routes stay the same.
