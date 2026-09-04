/**
 * Chat tools: tavern / adventure.
 * Required by packages/core/utils/toolsRegistry.js — apps keep requiring the facade.
 */


module.exports = {
    tavernInfo: {
        definition: {
            name: 'tavernInfo',
            description: 'Look inside the Goobster Tavern (the server\'s tabletop-RPG hub): the Common Room status, the quest board, today\'s rumor, an NPC, the requesting user\'s character sheet, or the shared world lore written by past adventures.',
            parameters: {
                type: 'object',
                properties: {
                    topic: {
                        type: 'string',
                        enum: ['status', 'board', 'rumor', 'npc', 'character', 'world'],
                        description: 'What to look up.'
                    },
                    npc: {
                        type: 'string',
                        enum: ['marnie', 'bix', 'caldra', 'albert'],
                        description: 'Which NPC (required when topic="npc").'
                    }
                },
                required: ['topic']
            }
        },
        execute: async ({ topic, npc, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const userId = interactionContext?.user?.id;
            if (!guildId) return '❌ The Tavern only manifests inside servers.';
            const tavernService = require('../../services/tavern/tavernService');
            const questLoader = require('../../services/tavern/questLoader');
            const adventureService = require('../../services/tavern/adventureService');
            const worldService = require('../../services/tavern/worldService');
            const characterService = require('../../services/tavern/characterService');

            if (topic === 'rumor') {
                return `🗣️ Rumor of the day: ${(await tavernService.getStatus(guildId)).rumor}`;
            }
            if (topic === 'status') {
                const status = await tavernService.getStatus(guildId);
                const open = status.openAdventures.map(a => `${a.title} (${a.status.toLowerCase()}, party of ${a.partySize}) in <#${a.channelId}>`);
                return `🍺 The Goobster Tavern. ${status.weather}\nRumor: ${status.rumor}\n` +
                    `Quests on the board: ${status.quests.map(q => q.title).join('; ')}.\n` +
                    `Open adventures: ${open.length > 0 ? open.join('; ') : 'none right now'}.\n` +
                    `${status.characterCount} adventurer(s) have characters here.`;
            }
            if (topic === 'board') {
                const quests = questLoader.getVisibleQuests();
                const lines = [];
                for (const quest of quests) {
                    const locked = !(await adventureService.isQuestUnlocked(guildId, quest));
                    lines.push(locked
                        ? `🔒 ${quest.title} - locked until the server completes "${questLoader.getQuest(quest.requires)?.title || quest.requires}".`
                        : `• ${quest.title} (${quest.players.min}-${quest.players.max} players, ${quest.duration}, ${quest.difficulty}): ${quest.hook.trim().split('\n')[0]}`);
                }
                return lines.join('\n');
            }
            if (topic === 'npc') {
                const card = tavernService.getNpc(guildId, npc);
                if (!card) return `❌ Nobody named "${npc}" drinks here. Residents: marnie, bix, caldra, albert.`;
                const standing = userId ? await worldService.getRelationship(guildId, npc, userId) : null;
                return `${card.emoji} ${card.name}, ${card.title}. ${card.description} ` +
                    `Today they say: "${card.line}"` +
                    (standing && standing.score !== 0 ? ` Their opinion of the requesting user: ${standing.label} (${standing.score}).` : '');
            }
            if (topic === 'character') {
                if (!userId) return '❌ I could not tell whose character to look up.';
                const character = await characterService.getCharacter(guildId, userId);
                if (!character) return 'The requesting user has no character yet - `/character create` takes about a minute.';
                return `${character.name} (${character.origin}) - ${character.calling}. ` +
                    `Might +${character.might}, Finesse +${character.finesse}, Wits +${character.wits}, Heart +${character.heart}. ` +
                    `Health ${character.health}/${character.maxHealth}, Spark ${character.spark}, ` +
                    `milestones ${character.milestones - character.advancesSpent} unspent. ` +
                    `Complication: "${character.complication}". Inventory: ${character.inventory.join(', ') || 'empty'}.`;
            }
            if (topic === 'world') {
                const world = await worldService.getWorld(guildId);
                const kinds = Object.keys(world);
                if (kinds.length === 0) return 'The Map Room is blank parchment - no adventure has marked the world yet.';
                return kinds.map(kind =>
                    `${kind}s: ${world[kind].map(entry => `${entry.name} (${entry.content.split('\n')[0].slice(0, 80)})`).join('; ')}`
                ).join('\n');
            }
            return `❌ Unknown topic "${topic}".`;
        }
    },
    tavernParty: {
        definition: {
            name: 'tavernParty',
            description: 'Manage the requesting user\'s adventure party in the CURRENT channel: post a new party for a quest, join the forming party, begin the adventure, leave it, or invite Goobster himself to play as a party member. Posts the party card / opening scene into the channel.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['create', 'join', 'begin', 'leave', 'invite-bot'],
                        description: 'What to do.'
                    },
                    questId: {
                        type: 'string',
                        description: 'Quest id for action="create" (see tavernInfo topic="board"; e.g. "missing-bell-of-brinewatch").'
                    }
                },
                required: ['action']
            }
        },
        execute: async ({ action, questId, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../../services/tavern/adventureService');
            const { TavernError } = require('../../services/tavern/tavernError');
            const views = require('../tavernViews');
            const { buildSceneView } = require('../../services/tavern/interactionHandler');
            const botAdventurer = require('../../services/tavern/botAdventurer');

            try {
                if (action === 'create') {
                    if (!questId) return '❌ action="create" needs a questId (see tavernInfo topic="board").';
                    const { adventure, quest } = await adventureService.createParty({ guildId, channelId: channel.id, questId, userId });
                    await channel.send(views.partyMessage(adventure, quest, await adventureService.getMembers(adventure.id)));
                    return `📜 Party posted for "${quest.title}" - the card with Join/Begin buttons is in the channel.`;
                }
                const open = await adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table. Use action="create" with a questId first.';
                if (action === 'join') {
                    const { quest, members } = await adventureService.join(open.id, userId);
                    return `🍻 The requesting user joined "${quest.title}" (party of ${members.length}).`;
                }
                if (action === 'begin') {
                    const { quest, members } = await adventureService.begin(open.id, userId);
                    await channel.send(await buildSceneView(open.id, '*The tale begins.*'));
                    await botAdventurer.maybeTakeTurn(open.id, channel);
                    return `🗡️ "${quest.title}" begins with a party of ${members.length}! The opening scene is posted in the channel.`;
                }
                if (action === 'leave') {
                    const { remaining, abandoned } = await adventureService.leave(open.id, userId);
                    return abandoned
                        ? '👋 The requesting user left, emptying the table - the adventure is shelved.'
                        : `👋 The requesting user left the party; ${remaining} adventurer(s) remain.`;
                }
                if (action === 'invite-bot') {
                    const botId = interactionContext?.client?.user?.id;
                    if (!botId) return '❌ I could not resolve my own account to pull up a chair.';
                    const { quest, members } = await adventureService.inviteBot(open.id, userId, botId);
                    return `🍻 Goobster pulls up a chair at the "${quest.title}" table (party of ${members.length}). He plays when the spotlight reaches him.`;
                }
                return `❌ Unknown action "${action}".`;
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernAct: {
        definition: {
            name: 'tavernAct',
            description: 'Take a freeform action for the requesting user in the CURRENT channel\'s active adventure - use this when they describe what their character does in plain words (e.g. "I ram the door with my cooking pot"). The engine rolls the check and posts the outcome to the channel.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        description: 'The player\'s action, in their words (1-300 characters).'
                    }
                },
                required: ['action']
            }
        },
        execute: async ({ action, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../../services/tavern/adventureService');
            const questLoader = require('../../services/tavern/questLoader');
            const narrator = require('../../services/tavern/narrator');
            const characterService = require('../../services/tavern/characterService');
            const { TavernError } = require('../../services/tavern/tavernError');
            const views = require('../tavernViews');
            const { buildSceneView, sendEnding } = require('../../services/tavern/interactionHandler');
            const botAdventurer = require('../../services/tavern/botAdventurer');

            try {
                const open = await adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table right now.';

                let interpretation = null;
                try {
                    const { quest, scene } = await adventureService.describe(open.id);
                    const character = await characterService.getCharacter(guildId, userId);
                    if (quest && scene && character) {
                        interpretation = await narrator.interpretAction(action, { scene, character }, { guildId, userId });
                    }
                } catch {
                    interpretation = null;
                }

                const result = await adventureService.freeform(open.id, userId, action, interpretation);
                try {
                    const { quest, scene } = await adventureService.describe(open.id);
                    const narration = await narrator.narrateOutcome({
                        quest, scene: scene || { title: 'the end of the tale', text: '' },
                        character: result.character, actionText: action,
                        stat: result.stat, dc: result.dc, roll: result.roll, total: result.total,
                        success: result.success, happenings: result.happenings
                    }, { guildId, userId });
                    if (narration) result.outcomeText = narration;
                } catch {
                    // keep the stock line
                }

                await channel.send(views.checkResultMessage(result, open.id));
                if (result.ended) {
                    const quest = questLoader.getQuest(result.adventure.questId);
                    await sendEnding(channel, quest, result.ended, guildId);
                } else if (result.sceneChanged) {
                    await channel.send(await buildSceneView(open.id));
                }
                await botAdventurer.maybeTakeTurn(open.id, channel);

                return `🎲 ${result.character.name} tried "${action}": ` +
                    (result.auto ? 'auto-success (big move).' : `d20(${result.roll}) + ${result.stat} = ${result.total} vs DC ${result.dc} -> ${result.success ? 'SUCCESS' : 'FAILURE'}.`) +
                    (result.happenings.length > 0 ? ` Consequences: ${result.happenings.join('; ')}` : '') +
                    ' The full outcome is posted in the channel.';
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernAttack: {
        definition: {
            name: 'tavernAttack',
            description: 'Attack a foe in the CURRENT channel\'s active adventure encounter, for the requesting user. Use when they say things like "I attack the golem" and the scene has enemies.',
            parameters: {
                type: 'object',
                properties: {
                    enemy: { type: 'string', description: 'The foe\'s name (matched loosely against living enemies).' },
                    stat: { type: 'string', enum: ['might', 'finesse', 'wits', 'heart'], description: 'Optional attack stat (default: their best of might/finesse).' }
                },
                required: ['enemy']
            }
        },
        execute: async ({ enemy, stat, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../../services/tavern/adventureService');
            const questLoader = require('../../services/tavern/questLoader');
            const { TavernError } = require('../../services/tavern/tavernError');
            const views = require('../tavernViews');
            const { buildSceneView, sendEnding } = require('../../services/tavern/interactionHandler');
            const botAdventurer = require('../../services/tavern/botAdventurer');

            try {
                const open = await adventureService.getOpenAdventureInChannel(channel.id);
                if (!open) return '❌ No adventure at this table right now.';
                const quest = questLoader.getQuest(open.questId);
                const living = quest ? adventureService.livingEnemies(open, quest) : [];
                if (living.length === 0) return '🍺 Nothing here wants fighting - options and freeform actions still work.';

                const wanted = String(enemy).trim().toLowerCase();
                const target = living.find(e => e.id === wanted)
                    || living.find(e => e.name.toLowerCase().includes(wanted))
                    || living[0];

                const result = await adventureService.attack(open.id, userId, target.id, stat);
                await channel.send(views.checkResultMessage(result, open.id));
                if (result.ended) {
                    await sendEnding(channel, questLoader.getQuest(result.adventure.questId), result.ended, guildId);
                } else if (result.sceneChanged) {
                    await channel.send(await buildSceneView(open.id));
                }
                await botAdventurer.maybeTakeTurn(open.id, channel);

                return `⚔️ ${result.character.name} attacked ${target.name}: ` +
                    (result.auto ? 'auto-hit (big move).' : `d20(${result.roll}) + ${result.stat} = ${result.total} vs defense ${result.dc} -> ${result.success ? 'HIT' : 'MISS'}.`) +
                    (result.happenings.length > 0 ? ` ${result.happenings.join('; ')}` : '');
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernTwist: {
        definition: {
            name: 'tavernTwist',
            description: 'Bend the running adventure\'s storyline: when the party wants the story to go somewhere the campaign didn\'t plan, forge new scenes that honor the idea and tie back into the campaign\'s existing endings. One twist per adventure; the requesting user must be a party member. Takes a while.',
            parameters: {
                type: 'object',
                properties: {
                    twist: { type: 'string', description: 'What the players want to happen instead (1-400 characters).' }
                },
                required: ['twist']
            }
        },
        execute: async ({ twist, interactionContext }) => {
            const guildId = interactionContext?.guildId;
            const channel = interactionContext?.channel;
            const userId = interactionContext?.user?.id;
            if (!guildId || !channel || !userId) return '❌ Adventures need a server text channel and a requesting user.';
            const adventureService = require('../../services/tavern/adventureService');
            const campaignForge = require('../../services/tavern/campaignForge');
            const { TavernError } = require('../../services/tavern/tavernError');
            const { buildSceneView } = require('../../services/tavern/interactionHandler');
            const botAdventurer = require('../../services/tavern/botAdventurer');
            const db = require('../../db');

            try {
                const open = await adventureService.getOpenAdventureInChannel(channel.id);
                if (!open || open.status !== 'ACTIVE') return '❌ No adventure in play at this table.';
                if (!(await adventureService.getMembers(open.id)).some(m => m.userId === userId)) {
                    return '🍺 Only party members may bend this story.';
                }
                if (open.state.twistUsed) {
                    return '🍺 This tale has already bent once - one big narrative detour per adventure keeps the spine intact.';
                }

                const { quest, scene } = await adventureService.describe(open.id);
                const recentLog = (await db.all(
                    `SELECT content FROM tavern_adventure_log WHERE adventureId = @id ORDER BY id DESC LIMIT 8`,
                    { id: open.id }
                )).map(row => `- ${row.content}`).reverse().join('\n');

                const { forkQuestId, entrySceneId, note } = await campaignForge.forgeTwist({
                    adventure: open, quest, scene, recentLog, twist, guildId, userId
                });
                await adventureService.applyTwist(open.id, forkQuestId, entrySceneId, note);

                await channel.send(`🌀 **The story bends.** ${note}`);
                await channel.send(await buildSceneView(open.id));
                await botAdventurer.maybeTakeTurn(open.id, channel);
                return `🌀 Twist applied: ${note}. New scenes were forged and the thread still leads back to the campaign's endings. The new scene is posted in the channel.`;
            } catch (error) {
                if (error instanceof TavernError) return `🍺 ${error.message}`;
                throw error;
            }
        }
    },
    tavernRecap: {
        definition: {
            name: 'tavernRecap',
            description: 'Fetch the stored recap of the most recently completed tavern adventure in this channel (or anywhere in the server).',
            parameters: { type: 'object', properties: {} }
        },
        execute: async ({ interactionContext }) => {
            const guildId = interactionContext?.guildId;
            if (!guildId) return '❌ The Tavern only manifests inside servers.';
            const adventureService = require('../../services/tavern/adventureService');
            const recap = await adventureService.getLatestRecap(guildId, interactionContext?.channel?.id || null)
                || await adventureService.getLatestRecap(guildId);
            if (!recap) return 'No tales concluded here yet - the recap book is blank.';
            return recap.content;
        }
    },
    rollDice: {
        definition: {
            name: 'rollDice',
            description: 'Roll dice: either a free expression (e.g. "2d6+1") or a tavern stat check (d20 + the requesting user\'s character stat, optionally vs a difficulty).',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'Dice expression like "d20", "2d6+1", "4d8-2".' },
                    stat: { type: 'string', enum: ['might', 'finesse', 'wits', 'heart'], description: 'Stat check instead of an expression.' },
                    dc: { type: 'integer', description: 'Difficulty to beat for a stat check (10 routine, 13 challenging, 16 difficult, 19 heroic).' }
                }
            }
        },
        execute: async ({ expression, stat, dc, interactionContext }) => {
            if (stat) {
                const guildId = interactionContext?.guildId;
                const userId = interactionContext?.user?.id;
                const characterService = require('../../services/tavern/characterService');
                const character = guildId && userId ? await characterService.getCharacter(guildId, userId) : null;
                const bonus = character ? character[stat] : 0;
                const roll = 1 + Math.floor(Math.random() * 20);
                const total = roll + bonus;
                let line = `🎲 ${character ? character.name : 'Flat'} ${stat} check: ${roll} + ${bonus} = ${total}`;
                if (Number.isInteger(dc)) line += ` vs DC ${dc} -> ${total >= dc ? 'SUCCESS' : 'FAILURE'}`;
                if (roll === 20) line += ' (natural 20!)';
                if (roll === 1) line += ' (natural 1 - a complication blooms)';
                return line;
            }
            const match = String(expression || '').trim().match(/^(\d*)d(\d+)([+-]\d+)?$/i);
            if (!match) return '❌ Give me a stat check (stat/dc) or an expression like "2d6+1".';
            const count = Math.max(1, Number(match[1] || 1));
            const sides = Number(match[2]);
            const modifier = Number(match[3] || 0);
            if (count > 20 || sides < 2 || sides > 1000) return '❌ Keep it to at most 20 dice with 2-1000 sides.';
            const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
            const total = rolls.reduce((sum, r) => sum + r, 0) + modifier;
            return `🎲 ${expression} -> ${total} (${rolls.join(' + ')}${modifier ? (modifier > 0 ? ` + ${modifier}` : ` - ${Math.abs(modifier)}`) : ''})`;
        }
    }
};
