---
title: Getting started with Goobster
kind: guide
summary: "A first visit to Goobster: ask a question, keep useful knowledge, organize a project, and find results and settings."
tags: [getting-started, onboarding, portal, documentation]
---

# Getting started with Goobster

Goobster is a workspace for conversations, saved knowledge, research, and projects. Start with a question. Keep what is useful. Build on it when you return.

## Sign in and take a first look

Open [Goobster](/app/). Use the sign-in method your host has enabled. You can use a native account without Discord; some installations require an invitation. If a feature is unavailable, your host may need to configure it.

On Home, try the **first research task**. It walks through a fictional question, a prepared research sample, evidence, a saved note, and a brief you can export. The sample needs no AI provider. Keeping its note is an explicit action. Live research is a separate action and needs a configured provider.

Room tutorials can be paused, skipped, resumed, or reset in [Settings → Tutorials](/app/settings/tutorials). Some tutorials are still being authored; see [tutorial coverage](guided_tutorials_spec.md#tutorial-catalog-and-coverage).

## Ask a question in Chat

Use [Chat](/app/chat) for a private conversation with Goobster. Ask a question, explore an idea, or work through a task. Available models, voice options, and tools depend on the installation and your settings.

When an answer is worth keeping, use **Save as note**. Saving knowledge is a deliberate step; a chat transcript and a note are different stored objects.

## Keep and explore knowledge

[Knowledge](/app/knowledge/notes), also called Spitball, has three views:

- **Notes:** read, edit, and organize saved information.
- **Map:** explore those same notes through their shared tags.
- **Research:** run an Expedition on a topic, inspect its sources, and create a brief.

Choose the scope before working. Personal knowledge and a project's shared knowledge have different audiences. **Add to project…** and **Use in discussion…** make an explicit transfer; they do not make your entire personal collection shared.

Read [Knowledge and memory](knowledge_and_memory.md), [Research expeditions](spitball_expeditions.md), and [Research briefs](research_brief.md) for details.

## Organize a project

Use [Projects](/app/projects) when work has a goal you will return to. A project brings together its plan, conversation, knowledge, files, apps, runs, people, and automations.

Begin with a concrete goal and check the plan before starting work. Inspect a run's status and outputs. Invite collaborators only when you intend to share that project's contents with them.

[Discussions](/app/discussions), also called the Parlor, supports conversations with people and AI personas. A project's Conversation view keeps its discussion alongside the project.

See [Projects](projects.md) for the detailed workflow and permissions.

## Find results in Activity

[Activity](/app/activity/inbox) has three separate views:

- **Inbox:** delivered results, reminders, and invitations.
- **Attention:** proactive notices, explanations, and controls to acknowledge, snooze, or dismiss them. Proactive attention is opt-in.
- **Scheduled:** reminders and recurring tasks.

Reading or archiving an Inbox item does not cancel the task that produced it. Check [Attention and scheduled work](attention.md) and [delivery without Discord](independent_runtime.md) for the underlying behavior.

## Control your settings and privacy

Open [Settings](/app/settings) for your profile, appearance, chat, voice, memory, initiative, connections, and account controls. [Usage & limits](/app/usage) shows usage and applicable limits. The **Host** area appears only for operators.

Saved knowledge, chat history, and personal memory are separate copies. Deleting one does not imply that every other copy is deleted. Read [the deletion controls](knowledge_and_memory.md#deletion-four-representations-four-controls) before choosing an action.

Goobster stores its application data on the host, but configured AI providers and external tools may receive data needed for a request. The host operator can access stored data. See [Where your data goes](../README.md#where-your-data-goes) for the deployment and privacy details.

## Explore optional tools

[Tools](/app/tools) contains Music Lab, Card decks, and the Trading game. Availability varies by installation; Discord-specific features explain when a Discord connection is required. The Trading game uses simulated currency.

## Find more help

Search this documentation by a feature name, a configuration key, or a phrase. Results open the matching section. The left navigation groups the guides, hosting instructions, and technical references; each open article lists its own sections.

You can also ask Goobster how a feature works. His **consultDocs** tool reads the repository documentation that these pages are built from. If you are setting up your own instance, start with [Installation and privacy](../README.md) or [Running without Discord](independent_runtime.md).
