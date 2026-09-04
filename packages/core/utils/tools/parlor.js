/**
 * Chat tools: parlor, facts, artifacts, and note lookup.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */


module.exports = {
    rememberFact: {
        definition: {
            name: 'rememberFact',
            description: 'Save a durable fact to the knowledge graph (also mirrored to the legacy facts table), e.g. a user preference, ongoing project, or important server detail. Use when you learn something worth remembering beyond this conversation.',
            parameters: {
                type: 'object',
                properties: {
                    fact: { type: 'string', description: 'Short declarative statement, e.g. "Rob prefers concise answers".' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server'],
                        description: 'Whether this fact is about the current user or the server as a whole.'
                    }
                },
                required: ['fact', 'about']
            }
        },
        execute: async ({ fact, about = 'user', interactionContext }) => {
            const factsService = require('../../services/factsService');
            const { dmScopeId } = require('../dmScope');
            // Facts are keyed on the guild, or on the user's DM scope in DMs
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            if (!guildId) return '❌ Facts can only be saved inside a conversation.';

            const isUser = about === 'user';
            const id = await factsService.addFact({
                guildId,
                subjectType: isUser ? 'USER' : 'GUILD',
                subjectId: isUser ? interactionContext.user?.id : null,
                content: fact,
                source: 'model'
            });
            return id ? `🧠 Remembered: "${fact}"` : '❌ Could not save that fact.';
        }
    },
    forgetFact: {
        definition: {
            name: 'forgetFact',
            description: 'Delete facts from the knowledge graph (and the legacy facts mirror) that match a phrase. Use when a saved fact is wrong or outdated, or when a user asks you to forget something about them.',
            parameters: {
                type: 'object',
                properties: {
                    match: { type: 'string', description: 'Phrase to match against stored facts (substring match).' },
                    about: {
                        type: 'string',
                        enum: ['user', 'server', 'any'],
                        description: 'Scope: facts about the current user, the server, or both.'
                    }
                },
                required: ['match']
            }
        },
        execute: async ({ match, about = 'any', interactionContext }) => {
            const factsService = require('../../services/factsService');
            const { dmScopeId } = require('../dmScope');
            // Same scoping as rememberFact: guild, or the user's DM scope
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            if (!guildId) return '❌ Facts only exist inside a conversation.';

            const removed = await factsService.removeFacts({
                guildId,
                subjectType: about === 'user' ? 'USER' : about === 'server' ? 'GUILD' : null,
                subjectId: about === 'user' ? interactionContext.user?.id : null,
                match
            });
            return removed > 0
                ? `🗑️ Forgot ${removed} fact${removed === 1 ? '' : 's'} matching "${match}".`
                : `I didn't have any facts matching "${match}".`;
        }
    },
    saveArtifact: {
        definition: {
            name: 'saveArtifact',
            description: 'Save a file from this conversation into the knowledge graph for later recall (code, markdown, PDFs, configs, images). Use when the user shares something worth keeping or explicitly asks you to remember/save it. If you are not sure they want it stored, ask first — then call again with confirm=true after they agree.',
            parameters: {
                type: 'object',
                properties: {
                    label: {
                        type: 'string',
                        description: 'Short graph title, e.g. "auth middleware snippet" or "homelab nginx config".'
                    },
                    summary: {
                        type: 'string',
                        description: 'One or two sentences of context: what this file is, why it matters, when to use it.'
                    },
                    attachmentIndex: {
                        type: 'integer',
                        description: 'Index from ATTACHMENTS THIS TURN (0-based). Required unless fileName matches exactly.'
                    },
                    fileName: {
                        type: 'string',
                        description: 'Original filename to match when attachmentIndex is omitted.'
                    },
                    tags: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'Optional concept tags, e.g. ["work", "python"].'
                    },
                    confirm: {
                        type: 'boolean',
                        description: 'Must be true to write. Ask the user first when unsure.'
                    }
                },
                required: ['label', 'confirm']
            }
        },
        execute: async ({
            label,
            summary = null,
            attachmentIndex = null,
            fileName = null,
            tags = [],
            confirm = false,
            interactionContext
        }) => {
            const kgArtifactService = require('../../services/kgArtifactService');
            const { dmScopeId } = require('../dmScope');
            const { normalizeIncomingAttachments } = require('../incomingAttachments');
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            const userId = interactionContext?.user?.id || null;
            if (!guildId || !userId) return '❌ Artifacts can only be saved inside a conversation.';

            const attachments = normalizeIncomingAttachments(interactionContext?.incomingAttachments);
            if (attachments.length === 0) {
                return '❌ No attachments on this turn to save. The user must attach a file first.';
            }

            let attachment = null;
            if (Number.isInteger(attachmentIndex)) {
                attachment = attachments.find(a => a.index === attachmentIndex) || attachments[attachmentIndex];
            }
            if (!attachment && fileName) {
                const target = String(fileName).trim().toLowerCase();
                attachment = attachments.find(a => String(a.name).toLowerCase() === target);
            }
            if (!attachment && attachments.length === 1) attachment = attachments[0];
            if (!attachment) {
                return `❌ Could not find that attachment. Available: ${attachments.map(a => `[${a.index}] ${a.name}`).join(', ')}`;
            }

            try {
                const saved = await kgArtifactService.saveArtifact({
                    guildId,
                    userId,
                    label,
                    summary,
                    attachment,
                    tags,
                    confirm,
                    channelId: interactionContext?.channelId || null,
                    messageId: interactionContext?.messageId || null
                });
                return `📎 Saved artifact "${saved.label}" (${saved.fileName}, ${saved.artifactKind}). You can recall it later with lookupNotes.`;
            } catch (error) {
                if (error.code === 'CONFIRM_REQUIRED') {
                    return 'Ask the user if they want this file saved, then call saveArtifact again with confirm=true.';
                }
                return `❌ Could not save artifact: ${error.message}`;
            }
        }
    },
    lookupNotes: {
        definition: {
            name: 'lookupNotes',
            description: 'Look up distilled notes and memories you already have. Use when a personal or server detail is missing from the prompt and guessing would be wrong. about="me" is this speaker; about="server" is shared server knowledge (not another person\'s private dossier).',
            parameters: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'What to look up, e.g. "homelab", "favorite tea", "deploy conventions".'
                    },
                    about: {
                        type: 'string',
                        enum: ['me', 'server'],
                        description: 'me = the current speaker; server = shared guild knowledge.'
                    }
                },
                required: ['query']
            }
        },
        execute: async ({ query, about = 'me', interactionContext }) => {
            const { dmScopeId, isDmScopeId } = require('../dmScope');
            const { retrieveNotes, formatRetrievedBlock } = require('../chat/promptContext');
            const guildId = interactionContext?.guildId
                || (interactionContext?.user?.id ? dmScopeId(interactionContext.user.id) : null);
            const userId = interactionContext?.user?.id || null;
            if (!guildId) return 'No conversation scope to search.';

            const scopeAbout = (!interactionContext?.guildId || isDmScopeId(guildId))
                ? 'me'
                : about;
            const result = await retrieveNotes({
                guildId,
                userId,
                query,
                depth: 'rich',
                mode: 'chat',
                about: scopeAbout,
                includeMemories: true
            });
            const block = formatRetrievedBlock(result, { heading: 'LOOKUP' });
            if (block) return block;

            const kgArtifactService = require('../../services/kgArtifactService');
            const knowledgeGraphService = require('../../services/knowledgeGraphService');
            const scopeKey = knowledgeGraphService.resolveScopeKey({
                subjectType: 'USER',
                subjectId: userId
            });
            const artifacts = await kgArtifactService.searchArtifacts({
                guildId,
                scopeKey,
                query,
                limit: 3
            });
            const artifactBlock = kgArtifactService.formatArtifactLines(artifacts, { maxChars: 2500 });
            if (artifactBlock) {
                const details = [];
                for (const row of artifacts.slice(0, 2)) {
                    const body = await kgArtifactService.readArtifactContent({
                        guildId,
                        scopeKey,
                        label: row.label,
                        maxChars: 1200
                    });
                    if (body) details.push(`--- ${row.label} (${row.originalName || 'file'}) ---\n${body}`);
                }
                return `LOOKUP — ARTIFACTS:\n${artifactBlock}${details.length ? `\n\n${details.join('\n\n')}` : ''}`;
            }

            return 'Nothing on file for that. Do not invent a personal detail; ask or use a web search if it is public knowledge.';
        }
    },
    manageParlor: {
        definition: {
            name: 'manageParlor',
            description: 'Operate the requesting user\'s Parlor (the multi-persona workspace in Goobster\'s web app at /app). ' +
                'Personas each keep a private tag-first knowledge base of notes; discussions seat up to 4 personas who reply ' +
                'grounded in their own notes. Use this to inspect or build the user\'s parlor on their behalf: list or create/edit ' +
                'personas, explore or add workspace notes, manage discussions, invite a Discord friend into a discussion ' +
                '(action "invite-user" - the friend gets a DM with accept/decline buttons and, once joined, takes part from ' +
                'their own web app), or bootstrap a whole salon from one topic brief (action "quickstart"). Everything acts ' +
                'on the requesting user\'s own parlor; results are visible in the web app. ' +
                'This tool never deletes anything - point the user at the web app for that.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['overview', 'quickstart', 'create-persona', 'update-persona',
                            'list-notes', 'create-note', 'update-note',
                            'create-conversation', 'rename-conversation', 'add-participant', 'remove-participant',
                            'invite-user'],
                        description: 'What to do. "overview" lists personas and discussions; "list-notes" browses or semantically searches one persona\'s workspace; "invite-user" invites a Discord friend into one of the user\'s discussions.'
                    },
                    prompt: { type: 'string', description: 'For "quickstart": what the salon should be about (the concierge designs 2-4 personas with seed notes and opens a discussion).' },
                    personaId: { type: 'integer', description: 'Persona id (from "overview") for persona/note actions.' },
                    personaIds: { type: 'array', items: { type: 'integer' }, description: 'Persona ids for "create-conversation" (1-4 seats).' },
                    conversationId: { type: 'integer', description: 'Discussion id for conversation actions.' },
                    noteId: { type: 'integer', description: 'Note id for "update-note".' },
                    name: { type: 'string', description: 'Persona name (create/update-persona).' },
                    emoji: { type: 'string', description: 'Persona emoji (create/update-persona).' },
                    charter: { type: 'string', description: 'Persona charter - who it is and how it thinks, 2-4 sentences in second person (create/update-persona).' },
                    voice: { type: 'string', description: 'ElevenLabs voice name or id for the persona\'s spoken voice in live parlor sessions (create/update-persona). Empty string clears back to the default voice.' },
                    title: { type: 'string', description: 'Note title (create/update-note) or discussion title (rename-conversation).' },
                    content: { type: 'string', description: 'Note content, 1-3 sentences (create/update-note).' },
                    tags: { type: 'array', items: { type: 'string' }, description: 'Lowercase concept tags for a note - shared tags connect notes (create/update-note).' },
                    query: { type: 'string', description: 'For "list-notes": semantic search query (omit to browse recent notes).' },
                    userId: { type: 'string', description: 'For "invite-user": the Discord user id (snowflake) of the friend to invite. Resolve mentions like <@123> to the bare id.' }
                },
                required: ['action']
            }
        },
        execute: async ({ action, prompt, personaId, personaIds, conversationId, noteId,
            name, emoji, charter, voice, title, content, tags, query, userId, interactionContext }) => {
            const ownerId = interactionContext?.user?.id;
            if (!ownerId) return '❌ I could not tell whose parlor to open.';
            const parlorService = require('../../services/parlorService');
            const { ParlorError } = require('../../services/parlorService');

            const personaLine = (p) =>
                `#${p.id} ${p.emoji ? `${p.emoji} ` : ''}${p.name} (${p.noteCount ?? 0} notes, ${p.tagCount ?? 0} tags)`;
            const noteLine = (n) =>
                `[note #${n.id}] ${n.title}${n.tags?.length > 0 ? ` (tags: ${n.tags.map(t => t.name).join(', ')})` : ''}: ${n.content}`;

            try {
                if (action === 'overview') {
                    const personas = await parlorService.listPersonas(ownerId);
                    const conversations = await parlorService.listConversations(ownerId);
                    if (personas.length === 0 && conversations.length === 0) {
                        return 'The parlor is empty - no personas or discussions yet. Offer the "quickstart" action (one topic brief sets up a whole salon) or create personas individually.';
                    }
                    return `Personas:\n${personas.map(personaLine).join('\n') || '(none)'}\n\n` +
                        `Discussions:\n${conversations.map(c =>
                            `#${c.id} "${c.title || 'Untitled'}" - ${c.participants.map(p => p.name).join(' + ') || 'no seats'}, ${c.messageCount} messages`
                        ).join('\n') || '(none)'}`;
                }
                if (action === 'quickstart') {
                    if (!prompt) return '❌ "quickstart" needs a prompt describing what the salon should be about.';
                    const result = await parlorService.quickstart({ ownerId, prompt });
                    return `⚡ Salon assembled: discussion #${result.conversation.id} "${result.conversation.title || 'Untitled'}" with ` +
                        `${result.personas.map(p => `${p.emoji ? `${p.emoji} ` : ''}${p.name}`).join(', ')} ` +
                        `(${result.seededNotes} seed notes). The user can open it in the web app's Parlor tab` +
                        (result.opening ? `; a good opening message: "${result.opening}"` : '.');
                }
                // Voice changes resolve against ElevenLabs at save time; a bad
                // name reports back without undoing the rest of the edit.
                const applyVoice = async (persona) => {
                    if (voice === undefined) return '';
                    try {
                        const updated = await parlorService.setPersonaVoice({
                            ownerId, personaId: persona.id, voice
                        });
                        return updated.voiceName
                            ? ` Voice set to "${updated.voiceName}".`
                            : ' Voice cleared back to the default.';
                    } catch (error) {
                        if (error instanceof ParlorError) return ` (Voice not set: ${error.message})`;
                        throw error;
                    }
                };
                if (action === 'create-persona') {
                    const persona = await parlorService.createPersona({ ownerId, name, emoji, charter });
                    const voiceNote = await applyVoice(persona);
                    return `✅ Persona ${personaLine(persona)} joined the parlor.${voiceNote} Seed their workspace with "create-note".`;
                }
                if (action === 'update-persona') {
                    if (!personaId) return '❌ "update-persona" needs a personaId (see "overview").';
                    const hasFields = name !== undefined || emoji !== undefined || charter !== undefined;
                    const persona = hasFields
                        ? await parlorService.updatePersona({ ownerId, personaId, name, emoji, charter })
                        : (await parlorService.listPersonas(ownerId)).find(p => p.id === Number(personaId));
                    if (!persona) return '🛋️ No such persona.';
                    const voiceNote = await applyVoice(persona);
                    return `✅ Persona updated: ${personaLine(persona)}.${voiceNote}`;
                }
                if (action === 'list-notes') {
                    if (!personaId) return '❌ "list-notes" needs a personaId (see "overview").';
                    if (query) {
                        const results = await parlorService.searchNotes({ ownerId, personaId, query, limit: 8 });
                        return results.length > 0
                            ? `Best matches in this workspace for "${query}":\n${results.map(noteLine).join('\n')}`
                            : `Nothing in this workspace matches "${query}".`;
                    }
                    const notes = (await parlorService.listNotes({ ownerId, personaId })).slice(0, 15);
                    return notes.length > 0
                        ? `Most recent notes:\n${notes.map(noteLine).join('\n')}`
                        : 'This workspace is empty - seed it with "create-note".';
                }
                if (action === 'create-note') {
                    if (!personaId) return '❌ "create-note" needs a personaId (see "overview").';
                    const note = await parlorService.createNote({ ownerId, personaId, title, content, tags: tags || [] });
                    return `✅ Filed ${noteLine(note)}`;
                }
                if (action === 'update-note') {
                    if (!noteId) return '❌ "update-note" needs a noteId (see "list-notes").';
                    const note = await parlorService.updateNote({ ownerId, noteId, title, content, tags });
                    return `✅ Updated ${noteLine(note)}`;
                }
                if (action === 'create-conversation') {
                    const conversation = await parlorService.createConversation({ ownerId, personaIds: personaIds || [] });
                    return `✅ Discussion #${conversation.id} opened with ${conversation.participants.map(p => p.name).join(' + ')}. ` +
                        'The user talks to it in the web app\'s Parlor tab.';
                }
                if (action === 'rename-conversation') {
                    if (!conversationId) return '❌ "rename-conversation" needs a conversationId (see "overview").';
                    const renamed = await parlorService.renameConversation({ ownerId, conversationId, title });
                    return `✅ Discussion #${renamed.id} is now "${renamed.title}".`;
                }
                if (action === 'add-participant' || action === 'remove-participant') {
                    if (!conversationId || !personaId) return `❌ "${action}" needs a conversationId and a personaId.`;
                    const { participants } = await parlorService.setParticipant({
                        ownerId, conversationId, personaId, present: action === 'add-participant'
                    });
                    return `✅ Discussion #${conversationId} now seats: ${participants.map(p => p.name).join(' + ') || 'nobody'}.`;
                }
                if (action === 'invite-user') {
                    if (!conversationId || !userId) return '❌ "invite-user" needs a conversationId and the friend\'s Discord userId.';
                    const inviteeId = String(userId).replace(/^<@!?(\d+)>$/, '$1');
                    const { dmSent, inviteeName } = await parlorService.invite({
                        gateway: interactionContext?.gateway || null,
                        client: interactionContext?.client || null,
                        ownerId,
                        ownerName: interactionContext?.user?.username || null,
                        conversationId,
                        inviteeId
                    });
                    const who = inviteeName || `user ${inviteeId}`;
                    return dmSent
                        ? `✉️ Invitation sent - ${who} got a DM with accept/decline buttons. Once they accept, the discussion shows up in their own web app Parlor tab.`
                        : `✉️ Invitation created for ${who}, but I couldn't DM them (their privacy settings). It still shows in their web app's Parlor tab under Invitations.`;
                }
                return `❌ Unknown action "${action}".`;
            } catch (error) {
                if (error instanceof ParlorError) return `🛋️ ${error.message}`;
                throw error;
            }
        }
    }
};
