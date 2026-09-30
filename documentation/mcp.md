---
title: "MCP server"
kind: guide
summary: A read-only Model Context Protocol server that lets Cursor and other clients search one person's Goobster workspace, with scoped, expiring tokens.
tags: [mcp, cursor, tokens, privacy, resources]
---

# MCP server

Goobster can speak the [Model Context Protocol](https://modelcontextprotocol.io)
as a **read-only** server. A client such as Cursor searches the signed-in
person's documentation, private memories, knowledge notes, projects, inbox,
and research. The tools and resources do not create, edit, or delete
anything.

This is separate from the GBA harness (`clients/gba-mcp/`), which is a
zero-dependency companion for mGBA. The server described here is Goobster
itself.

## Turning it on

The server is off until you opt in. In `config.json`:

```json
"mcp": {
  "enabled": true,
  "maxTokensPerUser": 10,
  "requestsPerMinute": 120,
  "defaultTokenDays": 90
}
```

`GOOBSTER_MCP_ENABLED=1` overrides the file, as do
`GOOBSTER_MCP_MAX_TOKENS`, `GOOBSTER_MCP_REQUESTS_PER_MINUTE`, and
`GOOBSTER_MCP_TOKEN_DAYS`. Restart after changing any of them.
The lite profile (the bot) and the full profile (the api process) both
mount `POST /mcp` when the switch is on. In Docker, nginx proxies `/mcp`
to the api service.

The portal routes that create tokens stay available even while the
endpoint is off, so you can mint a token and turn the server on afterwards.

## Tokens

A token is bound to one person, one scope, and (by default) a lifetime.
Goobster stores only its SHA-256. The plaintext (`gst_…`) is shown once.

- **Portal:** Settings → Connections → MCP access. Pick a label, a scope,
  and a lifetime.
- **CLI:** `npm run mcp:token -- create --user <principal id> --label "Cursor"
  [--scope read|docs] [--expires-days n]`. The secret is printed on stdout.
  `list` and `revoke --id <n>` manage the same rows.

The principal id is a Discord snowflake or a native `usr_…` id.

### Scopes

Whatever a client reads goes into the context of the model behind it, which
is often a third party. Pick the narrowest scope the client needs.

| Scope | What it can use |
| --- | --- |
| `read` (default) | Every tool and resource in this document. |
| `docs` | The three documentation tools and documentation resources. Nothing from a person's workspace: no memories, facts, notes, projects, inbox, expeditions, or briefs. |

`tools/list` shows a token only the tools its scope allows, and calling
another tool is an error naming the scope. There is no write scope.

### Lifetime

A new token expires after `mcp.defaultTokenDays` (90) unless the caller
chooses otherwise: 1 to 365 days, or `0` (`--expires-days 0`) for a token
that never expires. An expired token stops working at once. Over HTTP it
answers 401 with "This MCP token has expired", so a client can tell it from
a wrong token, and the portal marks it expired until you revoke it. Expired
tokens do not count toward the per-person cap.

Revoking a token, letting it expire, or running `/forget-me` makes it stop
working. Account export includes the label, prefix, scope, and expiry and
leaves the hash out.

Ten active tokens per person is the default cap (`mcp.maxTokensPerUser`,
hard ceiling 25). Each token accepts 120 requests a minute
(`mcp.requestsPerMinute`, ceiling 600). The cap resets when the process
restarts.

## Connecting a client

Send `Authorization: Bearer gst_…` on `POST /mcp`. The body is one JSON-RPC
message (`initialize`, `ping`, `tools/list`, `tools/call`, `resources/list`,
`resources/templates/list`, `resources/read`). There is no session. `GET` and `DELETE` answer 405. A JSON-RPC batch is rejected.

Cursor, stdio (the process can read the local database, and the token
still chooses whose workspace is visible):

```json
{
  "mcpServers": {
    "goobster": {
      "command": "node",
      "args": ["/absolute/path/to/goobster/apps/mcp/index.js"],
      "env": { "GOOBSTER_MCP_TOKEN": "gst_…" }
    }
  }
}
```

Run it directly with `npm run mcp` after exporting `GOOBSTER_MCP_TOKEN`.
stdout is the protocol. Logs go to stderr.

Cursor, HTTP (the bot or api is already running and reachable):

```json
{
  "mcpServers": {
    "goobster": {
      "url": "https://your-host.example/mcp",
      "headers": { "Authorization": "Bearer gst_…" }
    }
  }
}
```

Put the secret in the client config, not in a shell history you share.
The URL does not take the token as a query parameter.

If the request carries an `Origin` header, it must match the `Host`
header. Desktop clients omit Origin. A page on another site cannot call
the endpoint with a stolen bearer token from a browser.

## Tools

| Tool | Reads |
| --- | --- |
| `list_docs`, `search_docs`, `read_doc` | Goobster's own documentation. Operator notes are included only when the token owner is an active operator. |
| `search_memories` | Memories in that person's DM scope (`dm:<userId>`). Server-channel memories are not searched. |
| `list_facts` | Facts about that person in the same private scope. |
| `search_knowledge` | Personal notes (`USER:<userId>`), or one project's notes when `project` is a slug they can open. |
| `list_projects`, `get_project` | Name, description, role, and counts. |
| `list_project_files` | File names and sizes. File contents stay in the project workspace. |
| `list_inbox`, `get_inbox_item` | That person's inbox. |
| `list_expeditions`, `get_expedition` | Their Spitball expeditions, plus accepted source titles. |
| `get_brief`, `list_briefs` | Their research briefs: summary, findings, limitations, citations. |

Every tool advertises `readOnlyHint: true`. A result that is too long is
truncated at 16,000 characters.

## Resources

Clients that list resources (Cursor's `@` picker, for example) can attach a
document without a tool call.

| URI | Content | Scope |
| --- | --- | --- |
| `goobster://docs/<slug>` | One documentation page as Markdown. The slug is the one `list_docs` shows. | `read`, `docs` |
| `goobster://briefs/<id>` | One of the token owner's research briefs as text. | `read` |

`resources/list` returns documentation first, then the owner's most recent
briefs, 100 to a page with an opaque `nextCursor`. `resources/templates/list`
advertises the two URI shapes. A URI must match exactly: a title or a
partial slug is not accepted the way `read_doc` accepts one. A missing
resource, another person's brief, a brief asked for by a `docs` token, and
an operator note asked for by anyone but an active operator all answer the
same `-32002 Resource not found`, so ids and slugs are not an oracle. There
are no subscriptions and no prompts.

`search_memories` always does a keyword match. When an OpenAI embedding
key is configured, semantic recall is added. A local Ollama embed call is
not made from MCP: that client waits up to two minutes, and a down daemon
would stall the tool. Keyword search still works with no keys.

## Privacy

The token is the whole authorization. It can read the workspace of the
person it was minted for, within its scope, and nothing else. Guild
memories, other people's projects, and other people's briefs are not
returned, and a `docs` token reads no private data at all.

`/forget-me` deletes every `mcp_tokens` row for that person
(`counts.mcpTokens`). The audit table `mcp_tokens` is zero afterwards.
Requests are logged by method and tool name only. Arguments, document
text, and the bearer token are not written to the log. The work ledger is
not involved: a token label is not a prompt, and the secret is not a
ledger field.

## Where the code lives

- Protocol, tools, resources, and the per-scope surface: `packages/core/mcp/`
  (`protocol.js`, `tools.js`, `resources.js`, `surface.js`)
- Tokens: `packages/core/services/mcpTokenService.js`, table `mcp_tokens`
- Config: `packages/core/config/mcpConfig.js`
- Portal routes: `GET/POST/DELETE /api/app/mcp…` in `packages/core/web/routes/mcp.js`
- Settings UI: Settings → Connections
- stdio entry: `apps/mcp/index.js`
- CLI: `scripts/mcp-token.js`
