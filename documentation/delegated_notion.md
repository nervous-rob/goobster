---
title: Notion for delegated work (one page or database a responsibility may read and write as you)
kind: reference
summary: The Notion connector lets a responsibility read and write one Notion page or one Notion database that you name, with your own Notion token. It can read page text and database rows, append text, create pages in the database, and edit existing blocks and page properties. It cannot reach anything outside that page or database, and it cannot move anything to the trash - it can only ask, and each request waits for your approval. Covers the grant, what your Notion integration needs, every operation, the grey "Goobster - ref" line, what happens after a crash, the daily limit and the refusal codes.
when: Granting a responsibility a Notion page or database; setting up the Notion integration's capabilities and sharing; understanding what a run can and cannot change in Notion; approving or refusing a request to move something to the trash; reading a refusal such as OUTSIDE_RESOURCE, NOT_ON_ALLOWLIST, PRIVATE_CONTEXT, EXTERNAL_BUDGET or ASK_LIMIT on a Notion step; working out what the grey "Goobster · ref" line in a page is.
tags: [assistant, responsibilities, delegation, connectors, notion, authority, privacy, budgets, approval]
feature: assistant
---

# Notion for delegated work

A responsibility can be granted **one Notion page or one Notion database**
and a run under it can then read it and write to it, as you. Notion is the
first [outside connector](delegated_connectors.md); the decision is
[ADR 0030](adr/0030-notion-connector-and-per-action-approval.md).

It is part of the pilot: only the installation's owner can grant or use it
until the host records the
[pilot decision](delegated_operations.md#the-pilot-gate).

Nothing here changes what Goobster does with Notion in a conversation
(`searchNotion` and `readNotionPage`, which only read).

## Before you grant it

1. **Connect Notion** in Settings → Connections with an internal
   integration secret from <https://www.notion.so/profile/integrations>.
   It is your token; the host has none and none is used for you.
2. **Give the integration the capabilities the work needs**, on that same
   Notion page:
   - *Read content* for reading.
   - *Update content* for editing blocks and properties, and for moving
     something to the trash when you approve it.
   - *Insert content* for appending and for creating pages.

   No user or comment capability is needed. If a capability is missing,
   Notion refuses the call and the run reports "Not written (FORBIDDEN)".
3. **Share the page or database with the integration** in Notion (the page
   menu → Connections). A page that is not shared cannot be seen, and a
   grant on it is used as far as "Not read (NOT_FOUND)".
4. If you keep a list of **Notion pages Goobster may use** in Settings →
   Connections, the granted page or database has to be on it. An empty
   list restricts nothing.

## Granting it

In the draft form, under *Outside services*, choose Notion and paste the
page's or the database's link, then choose reading, writing or both. The
link (or a dashed id) is stored as the 32-character id, so the grant is
`{ "kind": "external", "ids": ["notion:<32 hex>"] }` on `read` and/or
`external.write`. One grant is one page or one database. There is no
workspace grant.

Activating needs what every connector needs: the pilot, your Notion
connection, and for writing, Attention at *delegate* with general external
writes allowed (see [delegated_connectors.md](delegated_connectors.md#granting-one)).

## What is inside a grant

The page or database you named and everything under it: its blocks, its
sub-pages, the databases in it and their rows. Nothing else, whatever your
token can see.

Goobster checks this itself before every call. For whatever the run names
(a page, a block, a database) it walks up the chain of parents until it
reaches the id you granted. If the chain reaches the workspace, cannot be
read, or is longer than twelve steps, the call is refused with
`OUTSIDE_RESOURCE` and nothing is sent for it. A page you later move out
of the granted page is outside from the next call.

## Reading (`read`)

| Operation | What it returns |
| --- | --- |
| `page` | A page's title, properties and text. Without a page id, the granted page |
| `blocks` | The blocks directly under a page or block, one per line with its id, so a block can be edited. 50 at a time |
| `rows` | Rows of a database: each row's page id, title and properties. Up to 25 at a time, optionally only rows whose title contains some text |

## Writing (`external.write`)

| Operation | What it does | Limits |
| --- | --- | --- |
| `append` | Adds text to the end of a page or under a block. Lines starting `#`, `-`, `- [ ]`, `1.` or `>` become headings, bullets, to-dos, numbered items and quotes | 60 lines and 6,000 characters a call |
| `createPage` | Adds a row (a page) to the granted database, or to a database inside the granted page, with a title, properties and optional text | The same |
| `updateBlock` | Replaces the text of one existing block, or ticks or unticks a to-do. The block keeps its type | Paragraphs, headings, list items, to-dos, toggles, quotes, callouts and code |
| `updatePage` | Sets properties of a page: its title, or a row's text, number, select, status, multi-select, checkbox, date, link, email or phone | Not relations, people, files, formulas or rollups (`UNSUPPORTED_PROPERTY`) |

What holds for all four:

- **They are made as you**, with your token, and they **cannot be undone
  from here**. Each result says so and is in the run's "Changed:" list.
  Notion's own page history is how you go back.
- **A daily limit.** They count against the responsibility's
  `budgets.externalOperations`, the same limit as pushes and pull requests:
  2 a day unless you set a number, at most 20. The next one is refused with
  `EXTERNAL_BUDGET`. Reading and asking are not counted.
- **Only after reading this resource, or nothing private.** A run that has
  read the granted page can write back to it. A run that has read your
  notes, or another Notion resource, cannot write to Notion at all
  (`PRIVATE_CONTEXT`): what it read elsewhere must not end up in the page.
  So "copy my notes into Notion" cannot be delegated.
- **A refusal from Notion is reported, not worked around.** "Not written
  (CODE)" means nothing changed.

### The grey line

Everything `append` and `createPage` add ends with one grey, italic line:

> *Goobster · ref 3f9a1c0b7d2e*

It tells you what Goobster wrote, and it is how Goobster checks its own
work: the reference is a fingerprint of that one step and holds nothing
about you or the text. You can delete the line once the work is done.

### After a crash

If Goobster stops between sending a write and recording it, the resumed
run asks Notion before doing anything again:

- for `append` and `createPage` it looks for the grey line. Found: the
  write is reported as done and is not repeated. Absent: it is made once.
  If there is too much under that parent to look through (more than 2,000
  blocks), the work stops for your review;
- for `updateBlock` and `updatePage` it compares what is there with what
  was asked. Equal: done. Different: it is set, which is safe to do twice.

A write Notion did not answer (a timeout, a server error) may have
happened; it takes the same path.

## Moving something to the trash: asked, never done for you

No grant lets a run remove anything. With `external.write` a run can call
`askConnector` with the operation `archive` and a page or block inside the
resource. That changes nothing in Notion. You get a request under **Needs
you** on Home and in the Inbox:

> **Move it to the trash: the page "Old drafts", in Notion?**
> Goobster asked for this while working for you and cannot do it itself.
> It is moved to the trash in Notion, as you. You can restore it from
> Notion's trash for 30 days.

- **Move it to the trash** does it then, with your token, after checking
  again that you are in the pilot, the host has not stopped delegated
  work, the responsibility still grants writing there, Notion is still
  connected and the thing is still inside the granted page or database.
- **Leave it** changes nothing, and the work is not asked to try again.

One request is one page or block. Nothing is approved in advance. Up to
five requests can wait per responsibility; a sixth is refused (`ASK_LIMIT`).
A request is withdrawn, with nothing changed, when the responsibility ends
or stops granting writing there, when you revoke Notion, or when the thing
has been moved out of the granted resource.

Never possible from here: moving the granted page or database itself to
the trash, moving a database to the trash, and deleting anything
permanently (Notion's API cannot).

If Notion does not answer when you approve, the card says it may or may
not have happened and stays open; approving again is safe.

## Revoking

*Revoke* on the Notion row of the Outside connectors card deletes your
Notion token. Every responsibility's next Notion call is refused, waiting
requests are withdrawn, and Notion stops working in conversations too,
because it is the same connection. Pausing or revoking the responsibility
stops only that responsibility.

## Refusals you may see

| Code | Meaning |
| --- | --- |
| `PILOT_ONLY` | Outside connectors are not open to your account yet |
| `NO_CREDENTIAL`, `RESOURCE_UNAVAILABLE` | Notion is not connected in your Settings |
| `NOT_ON_ALLOWLIST` | You keep a Notion allowlist and the granted page or database is not on it |
| `OPERATION_OUT_OF_SCOPE` | The run named a page or database other than the one granted |
| `OUTSIDE_RESOURCE` | What the run named is not inside the granted page or database |
| `PRIVATE_CONTEXT` | The run had read something private from somewhere else |
| `EXTERNAL_BUDGET` | The day's outside writes are used up |
| `ASK_LIMIT` | Five requests are already waiting for your answer |
| `RESOURCE_ARCHIVED`, `PAGE_ARCHIVED`, `BLOCK_ARCHIVED` | The granted resource, the page or the block is in Notion's trash |
| `NEEDS_PAGE`, `NEEDS_DATABASE` | The grant is a database and the call needed a page, or the other way round |
| `UNSUPPORTED_BLOCK`, `UNSUPPORTED_PROPERTY`, `NO_SUCH_PROPERTY`, `BAD_PROPERTY_VALUE` | That block or property cannot be set from here, or not to that value |
| `FORBIDDEN` | Notion refused: the integration lacks a capability, or the page is not shared with it |
| `NOT_FOUND` | Notion cannot see it with your token |
| `RATE_LIMITED` | Notion asked Goobster to slow down. Nothing changed |
| `OPERATION_UNCERTAIN` | A write may have happened and could not be checked. The work stops for your review |

## What is stored

- The grant, in the responsibility.
- The run's journal: which operation ran on which resource id, and its
  one-line result (for example "added 2 blocks to the page"). Not the
  page's text.
- A request to move something to the trash
  (`assistant_connector_requests`): the id and the title or first words of
  the thing. That is your content. It is in your export, it is deleted
  when you erase your data, and answered requests are removed after 180
  days.
- Your Notion token stays where it already was (`user_integrations`). It
  is read for one call and is never in a result, a journal row, a report
  or a log.

Notion content is never written to the work ledger, a log or the host's
view of delegated work.

## For developers

The manifest is `packages/core/services/assistant/connectors/notion.js`;
requests are `packages/core/services/assistantConnectorRequestService.js`.
Tests: `tests/notionConnector.test.js`, `tests/notionService.test.js`,
`tests/assistantConnectorRequests.test.js`, and the browser journey
`e2e/assistantNotion.spec.js`. They run against an in-memory Notion
(`tests/helpers/fakeNotion.js`); nothing in the suite talks to Notion.
