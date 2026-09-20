---
title: "Exploration: product naming, no rename selected"
kind: decision
summary: Uncommitted naming exploration for the wider workspace, including preserving Goobster as the assistant name. Candidates have not been checked for domains, trademarks, or availability; no rebrand is selected.
tags: [planning, naming, brand, product]
---

# Product naming exploration

**Status: exploration only. No name change is selected or implemented.**

Updated: 20 September 2026.

Related: [shared-instance product design and rollout](shared_instance_product_spec.md).

The product name and the assistant's personal name can differ. **Goobster can remain the assistant or a selectable persona** while the wider application adopts a more descriptive or mature name. That preserves continuity without requiring the platform identity to carry the same tone.

These are creative candidates, not checked trademarks, available domains, or availability claims.

| Direction / candidate | What it suggests | Where it may fall short |
|---|---|---|
| **Trestle** | A structure that supports work and connects components; practical and sturdy. | The knowledge/intelligence meaning needs a descriptor; likely naming collisions. |
| **Fieldnote** | Observation, research, evidence, and learning through experiments. | Sounds more like a notebook than an execution workspace. |
| **Waymark** | Orientation, continuity, progress through difficult work. | May suggest navigation more than creation. |
| **Cairn** | Accumulated understanding and markers along an exploratory path. | Abstract; spelling/pronunciation and existing uses need checking. |
| **Parlor** | Conversation, shared thought, and a personal place. | Existing feature overlap and weaker association with technical work. |
| **Nervous Atlas** | A Nervous Labs family identity; knowledge, connections, and discovery. | Longer; “Nervous” has mixed connotations outside the existing brand. |
| **Workbench** | A place for tools, projects, and experiments. | Highly generic and may understate memory and conversation. |
| **Commonplace** | Personal knowledge built over time; a familiar intellectual tradition. | Weak signal for executing tasks, and a crowded ordinary word. |

Initial directions to explore are **Trestle** for productive work, **Fieldnote** for research and knowledge, and **Nervous Atlas** for brand continuity. Try each with a plain descriptor, such as “A self-hosted workspace for knowledge and action.” These are alternatives, not a recommendation to rename now.

Evaluate later against pronunciation, spelling after hearing it once, product breadth, warmth, search distinctiveness, existing software, package names, domains, and trademark risk. Availability checks come after a shortlist. Do not rename packages, environment variables, URLs, stored data, or public APIs as part of the shared-instance documentation change.

## Decision process

1. Shortlist candidates against the product's core qualities: knowledgeable, productive, experimental, connected, and self-hosted.
2. Test pronunciation, spelling, and comprehension with people who have not seen the app. Use the same plain product descriptor for each candidate.
3. Check existing products, repositories/packages, domains, and relevant trademarks before making availability claims or choosing a name.
4. Make an explicit product-name decision separately from the assistant/persona name.
5. If a rename is chosen, plan aliases and compatibility for deployment configuration, URLs, API contracts, packages, and stored data before changing them.

Continue using Goobster in code, current documentation, and release artifacts until that decision is made.
