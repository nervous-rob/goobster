---
title: "Self-knowledge: Goobster's own documentation"
kind: guide
summary: How the repository's documentation is seeded into the database at build/run time and consulted by the model through the consultDocs tool, including how to write skill guides and operator notes.
tags: [self-docs, documentation, consultDocs, skills, seeding]
---

# Self-knowledge: Goobster's own documentation

Goobster is the software these documents describe, so he should be able to read
them. This feature seeds the repository's Markdown into the database and gives
the model one tool, `consultDocs`, to search it, read a document or section, and
list the corpus - including **skill guides**, authored procedures for specific
jobs (troubleshooting, project examples, working guidelines).

People can browse selected shipped files through the portal's **Documentation**
link at `/app/docs`. The [documentation wiki](documentation_wiki.md) builds a
public reader and local search index from an explicit repository manifest.
It does not query this service, seed a database, or include operator notes.

- Service: `packages/core/services/selfDocsService.js`
- Config: `packages/core/config/selfDocsConfig.js` (env → `config.json` → defaults)
- Tool: `consultDocs` in `packages/core/utils/tools/selfDocs.js` (via the
  `toolsRegistry` facade)
- Table: `self_docs` in `packages/core/db/schema.sql`
- Script: `npm run docs:seed` (`scripts/seed-self-docs.js`), `npm run docs:check`
- Prompt guidance: the `YOUR OWN DOCUMENTATION` block in
  `utils/toolPromptBuilder.js` (shared by every provider)

## What gets seeded

`selfDocs.sources` (default `README.md` and `documentation/`, walked
recursively - ADRs and `documentation/skills/` included) plus the operator
directory `selfDocs.operatorDir` (default `data/self-docs/`, walked under the
slug prefix `operator/`). Only `*.md` files; dot-directories are skipped.

Each file becomes one **document** with a stable slug derived from its path
(`documentation/code_sandbox`, `documentation/skills/troubleshooting`,
`operator/production-box`) and metadata:

| Field | Source |
|---|---|
| `title` | front matter `title`, else the first `# ` heading, else the file name |
| `kind` | front matter `kind` (`guide`, `reference`, `standards`, `decision`, `skill`) or inferred from the path: `skills/` → skill, `adr/` → decision, names containing *standards/guidelines* → standards, *guide/setup/deployment/install/testing* → guide, otherwise reference |
| `summary` | front matter `summary`, else the first paragraph |
| `useWhen` | front matter `when` (skill guides: when the procedure applies) |
| `tags` | front matter `tags` |

The body is split into **chunks** at headings (fenced code is never split or
mistaken for a heading), small neighbouring sections are merged and oversized
ones split on blank lines, aiming at ~1,800 characters. Every chunk carries a
`Title > Section > Subsection` breadcrumb and a content hash.

## When seeding happens

- **Every bot start** (`selfDocs.seedOnStartup`, default on) from
  `apps/bot/index.js` after the database opens. The seed is idempotent:
  unchanged chunks are untouched (their embeddings survive), changed chunks are
  rewritten with their vector cleared, trailing chunks and vanished documents are
  deleted. It runs under the `self_docs_seed` singleton lock, so two bot
  processes on Postgres never interleave.
- **`npm run db-init`** seeds after creating the SQLite file.
- **`npm run docs:seed`** on demand (`-- --embed` also waits for embeddings;
  `-- --stats` prints the table). Use it after adding operator notes without a
  restart.
- **Image build**: the Dockerfile runs `scripts/seed-self-docs.js --check`, a
  parse-only validation with no database, so a malformed doc fails the build.
  The same validation runs in the unit suite against the real corpus.
- **Lazily**: `consultDocs` seeds when it finds the table empty (the api
  process may serve a portal chat before the bot ever ran).

## Retrieval

`selfDocsService.search` is hybrid and degrades gracefully:

- **Keyword ranking (always)**: BM25 over stemmed tokens, with the title
  weighted ×3, the heading breadcrumb and tags ×2. Identifiers are indexed both
  whole and split on camelCase/snake_case, so `runCode` matches "run code".
  Needs no keys and no network.
- **Semantic ranking (when available)**: chunk vectors are backfilled in the
  background after each seed (`selfDocs.embeddings`, default on) using
  `embeddingService` - OpenAI `text-embedding-3-small` or Ollama
  `nomic-embed-text`, whichever the deployment has. Vectors are tagged with
  their model and only compared to a query embedded by the same model. The two
  rankings are fused with reciprocal-rank fusion; at most three chunks per
  document appear in one result set.
- The in-memory index is transient, re-derivable state: rebuilt from the table
  on demand, invalidated by a seed in this process, and expired on a five-minute
  TTL so the api process notices a bot re-seed.

## The tool

`consultDocs` is offered on every surface (guild, DM, portal, automations) - the
shipped corpus is public repository documentation, not user data. Operator
notes are filtered from search, listing, and document resolution unless a
currently active operator is using their private portal Chat. Shared
discussions, guilds, and missing actor context receive only shipped docs.

| Action | Parameters | Returns |
|---|---|---|
| `search` (default when `query` is given) | `query`, optional `kind`, `limit` (≤ 8) | Ranked sections with breadcrumb, kind, path, and the slug to read more |
| `read` | `slug` (slug, path, or title), optional `section`, `offset`, `limit` | A line window of the document (or the sections whose breadcrumb matches), the same contract as the other file-shaped tools |
| `list` | optional `kind` | The document index grouped by kind; skill guides show their summary and *Use when* line |

The shared tool guidance tells the model to consult the docs before answering
anything about how it works or when one of its own features fails, to read the
relevant skill guide in full before doing that kind of job, and never to invent
configuration keys or commands. When `selfDocs.enabled` is false the tool is not
registered and the guidance block is omitted.

## Writing a skill guide

Skill guides live in `documentation/skills/` and are ordinary Markdown with
front matter:

```markdown
---
title: Troubleshooting tactics
kind: skill
summary: One or two sentences the model sees in the index.
when: The situation in which the model should read this guide.
tags: [troubleshooting, errors]
---

# Troubleshooting tactics
...
```

`summary` is required for skills (the corpus check fails without it). Write for
the model: a method, then tables of *symptom → cause → who fixes it*, then what
not to do. Cite other documents by title so the model can `read` them. Shipped
guides: *Troubleshooting tactics*, *Project examples*, *Working guidelines*.

## Operator notes

Drop Markdown into `data/self-docs/` (or `selfDocs.operatorDir`) to teach a
deployment about itself - the production host, who owns which credential,
house rules for a server. They are seeded like shipped docs but returned by
`consultDocs` only to an authorized operator in their private portal Chat.
They never appear in the public documentation wiki. Front matter works the
same way; `kind: skill` makes a note a procedure.

## Configuration

| `config.json` | Environment | Default | Meaning |
|---|---|---|---|
| `selfDocs.enabled` | `GOOBSTER_SELF_DOCS_ENABLED` | `true` | Register the tool and seed the corpus |
| `selfDocs.seedOnStartup` | `GOOBSTER_SELF_DOCS_SEED_ON_STARTUP` | `true` | Re-seed on every bot start |
| `selfDocs.embeddings` | `GOOBSTER_SELF_DOCS_EMBEDDINGS` | `true` | Backfill chunk vectors when a backend exists |
| `selfDocs.sources` | `GOOBSTER_SELF_DOCS_SOURCES` | `README.md, documentation` | Files/directories walked for `*.md` |
| `selfDocs.operatorDir` | `GOOBSTER_SELF_DOCS_OPERATOR_DIR` | `data/self-docs` | Operator-authored notes |

## Invariants

- Shipped documentation is public, **not per-user data**. Do not put private
  content in repository sources. Deployment notes belong in the protected
  operator directory, never in the public wiki manifest.
- Seeding must stay idempotent and hash-compared; a restart with unchanged docs
  writes nothing and preserves embeddings.
- Retrieval must keep working with no credentials; embeddings are an
  improvement, never a dependency.
- Engine parity: SQL is SQLite dialect through the `db/` facade; the suite runs
  on both engines.
- Documentation is what the model reads - a feature shipped without a document
  is invisible to Goobster. Keep docs current and keep skill guides accurate to
  the tools they name.

Tests: `tests/selfDocs.test.js` (parsing, chunking, idempotent seeding, hybrid
search with an injected embedder, reading, listing, the tool's formatting, and
the real-corpus validation).
