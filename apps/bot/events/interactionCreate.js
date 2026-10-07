// TODO: Add proper handling for interaction state management
// TODO: Add proper handling for interaction state persistence
// TODO: Add proper handling for interaction button state
// TODO: Add proper handling for interaction context loss
// TODO: Add proper handling for interaction timeouts
// TODO: Add proper handling for interaction response timeouts
// TODO: Add proper handling for interaction cleanup
// TODO: Add proper handling for interaction error recovery
// TODO: Add proper handling for interaction deferral failures
// TODO: Add proper handling for interaction followup failures

const AISearchHandler = require('@goobster/core/utils/aiSearchHandler');
const perplexityService = require('@goobster/core/services/perplexityService');
const aiService = require('@goobster/core/services/aiService');
const { chunkMessage } = require('@goobster/core/utils');
const { getPrompt, getPromptWithGuildPersonality } = require('@goobster/core/utils/memeMode');
const inventory = require('@goobster/core/features/inventory');
const { features } = require('@goobster/core/features/featureState');
const { requireSurface, unavailableResult } = require('@goobster/core/features/gate');
const { featureCommandFilter } = require('@goobster/core/utils/commandDeployment');
const lifecycle = require('@goobster/core/runtime/lifecycle');

const UNAVAILABLE_TEXT = 'That feature is not available on this installation.';
const restartingText = seconds => `Goobster is restarting in ${seconds} s. Try that again in a minute.`;
const COLLECTOR_PREFIX = 'collector:';

/**
 * `intaction` buttons are core dispatch, but the pending row decides which
 * feature the action belongs to (documentation/feature_inventory.md S1).
 */
const INTEGRATION_ACTION_OWNERS = {
    'agent-launch': 'cursor',
    'github-issue': 'github'
};

/**
 * Router tokens whose pending row can still be cleared with the feature off:
 * a Deny / Cancel press only resolves the pending row (nothing executes), so
 * it is let through; Approve / Confirm, which runs the work, is refused.
 * "Disabled is not deleted": otherwise the rows could never be closed.
 */
const RESOLVE_ONLY_ACTIONS = {
    sbxreq: ['deny'],
    intaction: ['deny']
};

function claimedToken(token) {
    return typeof token === 'string'
        && Object.prototype.hasOwnProperty.call(inventory.interactionTypes, token);
}

/**
 * Resolve a customId to its inventory row. The full id is tried first
 * (`collector:<id>`: buttons that a command's own collector handles and the
 * router must never touch, e.g. `clear_search_button`, whose second segment
 * would otherwise parse as the `search` router token); then the router token.
 * @returns {{ key: string, collector: boolean }|null}
 */
function resolveInteractionSurface(customId) {
    const exact = `${COLLECTOR_PREFIX}${customId}`;
    if (claimedToken(exact)) return { key: exact, collector: true };
    const token = String(customId).split('_')[1];
    if (claimedToken(token)) return { key: token, collector: false };
    return null;
}

/** The unavailable result for an `intaction` button whose pending action belongs to a feature that is off, else null. */
async function integrationActionRefusal(customId) {
    const requestId = Number(String(customId).split('_')[2]);
    if (!Number.isInteger(requestId)) return null;
    // Nothing either owner could refuse: no extra read on a default install.
    if (!Object.values(INTEGRATION_ACTION_OWNERS).some(owner => features.enforcedOff(owner))) return null;
    try {
        const db = require('@goobster/core/db');
        const row = await db.get('SELECT type FROM pending_integration_actions WHERE id = @id', { id: requestId });
        const owner = row && INTEGRATION_ACTION_OWNERS[row.type];
        if (owner && features.enforcedOff(owner)) return unavailableResult(owner);
    } catch {
        // The service reports its own database problems.
    }
    return null;
}

/**
 * Ephemeral standard refusal. Never throws; a dead interaction token is not
 * an error worth surfacing.
 */
async function replyUnavailable(interaction, content = UNAVAILABLE_TEXT) {
    const payload = { content, ephemeral: true, allowedMentions: { parse: [] } };
    try {
        if (interaction.deferred || interaction.replied) await interaction.followUp(payload);
        else await interaction.reply(payload);
    } catch (error) {
        console.warn('Could not send the feature-unavailable reply:', error.message);
    }
}

/**
 * Component/modal gate. Resolves the owner before any handler runs.
 * @returns {Promise<{ handled: boolean }>} `handled` = nothing else may touch this interaction
 *   (refused, or owned by a command's own collector)
 */
async function gateComponentInteraction(interaction) {
    const surface = resolveInteractionSurface(interaction.customId);
    if (!surface) return { handled: false };
    const action = String(interaction.customId).split('_')[0];
    if ((RESOLVE_ONLY_ACTIONS[surface.key] || []).includes(action)) return { handled: surface.collector };
    let refusal = requireSurface('interactionType', surface.key);
    if (!refusal && surface.key === 'intaction') refusal = await integrationActionRefusal(interaction.customId);
    if (refusal) {
        await replyUnavailable(interaction);
        return { handled: true, refusal };
    }
    return { handled: surface.collector };
}

/**
 * A slash command, autocomplete or context menu whose command file was left
 * out of this process because its feature is not active (Discord can still
 * hold the old registration for a while). Replies ephemerally and returns
 * true; a command name nothing claims is left to the caller's usual path.
 *
 * The same reply answers feature-owned commands while a restart the
 * manager announced drains this process ("restarting in N s"); core
 * commands keep working, and a plain stop announces nothing.
 * @param {Object} interaction
 * @param {Map<string, { kind: string, key: string }>} nameIndex from commandNameIndex()
 * @param {{ restartNotice?: () => ({ secondsLeft: number }|null) }} [worker] the process lifecycle
 */
async function refuseUnavailableCommand(interaction, nameIndex, worker = lifecycle) {
    const entry = nameIndex.get(interaction.commandName);
    if (!entry) return false;
    const restarting = worker.restartNotice?.() || null;
    let available;
    try {
        available = featureCommandFilter(entry.kind, entry.key);
    } catch {
        available = false;
    }
    if (available && !(restarting && inventory.ownerOf(entry.kind, entry.key)?.owner !== 'core')) return false;
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
        try { await interaction.respond([]); } catch { /* the autocomplete window closed */ }
        return true;
    }
    await replyUnavailable(interaction, available ? restartingText(restarting.secondsLeft) : UNAVAILABLE_TEXT);
    return true;
}

module.exports = {
    name: 'interactionCreate',
    UNAVAILABLE_TEXT,
    resolveInteractionSurface,
    gateComponentInteraction,
    refuseUnavailableCommand,
    replyUnavailable,
    async execute(interaction) {
        let interactionState = {
            deferred: false,
            replied: false,
            error: null
        };

        try {
            // Stale buttons/modals/selects of a disabled feature are refused
            // before any handler (or database write) runs; ids a command's own
            // collector owns are never routed here.
            const isComponent = interaction.isButton()
                || (typeof interaction.isMessageComponent === 'function' && interaction.isMessageComponent())
                || (typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit());
            if (isComponent && interaction.customId) {
                const gated = await gateComponentInteraction(interaction);
                if (gated.handled) return;
            }

            // Handle button interactions
            if (interaction.isButton()) {
                const [action, type, requestId] = interaction.customId.split('_');

                // Tavern adventure buttons (join / begin / scene options / Spark reroll).
                // State lives in SQLite, so these survive restarts.
                if (type === 'tavern') {
                    const tavernHandler = require('@goobster/core/services/tavern/interactionHandler');
                    await tavernHandler.handleButton(action, requestId, interaction);
                    return;
                }

                // Parlor discussion invitations (accept/decline from the DM).
                // State lives in SQLite (parlor_invites), so these survive
                // restarts like the tavern buttons.
                if (type === 'parlorinvite') {
                    const parlorService = require('@goobster/core/services/parlorService');
                    await parlorService.handleInviteButton(action, requestId, interaction);
                    return;
                }

                // Project collaboration invitations (accept/decline from the DM).
                if (type === 'projectinvite') {
                    const projectService = require('@goobster/core/services/projectService');
                    await projectService.handleInviteButton(action, requestId, interaction);
                    return;
                }

                // Operator-approved sandbox requests (package installs /
                // data fetches) - resolved from the approver's DM buttons.
                if (type === 'sbxreq') {
                    const sandboxRequestService = require('@goobster/core/services/sandboxRequestService');
                    await interaction.deferUpdate();
                    interactionState.deferred = true;
                    const edit = await sandboxRequestService.handleButton(action, Number(requestId), interaction);
                    if (edit) {
                        await interaction.message.edit(edit).catch(error => {
                            console.error('Failed to update sandbox request message:', error);
                        });
                    }
                    return;
                }

                // "Let me in" requests from the portal - approved or declined
                // by the host from the DM buttons (documentation/identity.md).
                if (type === 'accessreq') {
                    const accessRequestService = require('@goobster/core/services/accessRequestService');
                    await interaction.deferUpdate();
                    interactionState.deferred = true;
                    const edit = await accessRequestService.handleButton(action, Number(requestId), interaction);
                    if (edit) {
                        await interaction.message.edit(edit).catch(error => {
                            console.error('Failed to update access request message:', error);
                        });
                    }
                    return;
                }

                // Friend requests - accepted or declined from the DM echo's
                // buttons (documentation/friends_and_messages.md).
                if (type === 'friendreq') {
                    const friendService = require('@goobster/core/services/friendService');
                    await interaction.deferUpdate();
                    interactionState.deferred = true;
                    const edit = await friendService.handleButton(action, Number(requestId), interaction);
                    if (edit) {
                        await interaction.message.edit(edit).catch(error => {
                            console.error('Failed to update friend request message:', error);
                        });
                    }
                    return;
                }

                // Confirmable integration actions (agent launch / issue create)
                if (type === 'intaction') {
                    const integrationActionService = require('@goobster/core/services/integrationActionService');
                    await interaction.deferUpdate();
                    interactionState.deferred = true;
                    const edit = await integrationActionService.handleButton(action, Number(requestId), interaction);
                    if (edit) {
                        await interaction.message.edit(edit).catch(error => {
                            console.error('Failed to update integration action message:', error);
                        });
                    }
                    return;
                }

                if (type === 'search') {
                    try {
                        await interaction.deferUpdate();
                        interactionState.deferred = true;
                    } catch (deferError) {
                        console.warn('Failed to defer interaction update:', {
                            error: deferError.message,
                            customId: interaction.customId
                        });
                    }

                    if (action === 'approve') {
                        const result = await AISearchHandler.handleSearchApproval(requestId, interaction);
                        if (result) {
                            // Get the original conversation context
                            const messages = await interaction.channel.messages.fetch({ limit: 10 });
                            const originalQuestion = messages.find(m => 
                                !m.author.bot && 
                                m.id === interaction.message.reference?.messageId || 
                                messages.filter(msg => !msg.author.bot).first()
                            );

                            if (originalQuestion) {
                                const initialResponse = await interaction.channel.send({
                                    content: "🤔 Let me think about that for a moment..."
                                }).catch(error => {
                                    console.error('Failed to send initial response:', {
                                        error: error.message,
                                        channelId: interaction.channel.id
                                    });
                                    return null;
                                });

                                if (!initialResponse) {
                                    throw new Error('Failed to send initial response message');
                                }

                                try {
                                    // Get system prompt with meme mode and guild personality
                                    const guildId = interaction.guild?.id;
                                    const systemPrompt = await getPromptWithGuildPersonality(interaction.user.id, guildId);
                                    
                                    // Build conversation history with search results
                                    const conversationHistory = [
                                        { role: 'system', content: systemPrompt },
                                        { role: 'user', content: originalQuestion.content },
                                        { role: 'system', content: `Here is relevant information to help answer the question: ${result.result}` }
                                    ];

                                    const responseContent = await aiService.chatText(
                                        conversationHistory,
                                        {
                                            preset: 'chat',
                                            max_tokens: 500
                                        }
                                    );

                                    let firstResponseMsg = await initialResponse.edit({
                                        content: responseContent
                                    });

                                    // Add reactions for interaction
                                    const reactions = [
                                        ['🔄', 'Regenerate'],
                                        ['📌', 'Pin important messages'],
                                        ['🌳', 'Branch conversation'],
                                        ['💡', 'Mark as solution'],
                                        ['🔍', 'Deep dive/expand'],
                                        ['📝', 'Summarize thread']
                                    ];

                                    for (const [emoji, description] of reactions) {
                                        try {
                                            await firstResponseMsg.react(emoji);
                                            await new Promise(resolve => setTimeout(resolve, 250));
                                        } catch (reactionError) {
                                            if (reactionError.code === 10014) {
                                                console.warn(`Emoji ${emoji} not available:`, {
                                                    description,
                                                    error: reactionError.message
                                                });
                                                continue;
                                            }
                                            if (reactionError.code === 30016) {
                                                console.warn('Rate limited while adding reactions, waiting...');
                                                await new Promise(resolve => setTimeout(resolve, 5000));
                                                try {
                                                    await firstResponseMsg.react(emoji);
                                                } catch (retryError) {
                                                    console.warn(`Failed to add ${description} reaction after retry:`, {
                                                        emoji,
                                                        error: retryError.message
                                                    });
                                                }
                                                continue;
                                            }
                                            console.warn(`Failed to add ${description} reaction:`, {
                                                emoji,
                                                error: reactionError.message
                                            });
                                        }
                                    }
                                } catch (error) {
                                    console.error('Error generating AI response:', {
                                        error: error.message || 'Unknown error',
                                        stack: error.stack || 'No stack trace available',
                                        requestId,
                                        channel: interaction.channel?.name || 'Unknown channel'
                                    });

                                    if (initialResponse) {
                                        await initialResponse.edit({
                                            content: "I apologize, but I encountered an error while analyzing the information. Please try again."
                                        }).catch(console.error);
                                    }

                                    AISearchHandler._deletePendingRequest(requestId);

                                    interactionState.error = error;
                                }
                            }
                        }
                    }

                    if (action === 'deny') {
                        await AISearchHandler.handleSearchDenial(requestId, interaction)
                            .catch(error => {
                                console.error('Failed to handle search denial:', {
                                    error: error.message,
                                    requestId
                                });
                                interactionState.error = error;
                            });
                    }
                }
            }
        } catch (error) {
            console.error('Error in interaction handler:', {
                error: error.message || 'Unknown error',
                stack: error.stack || 'No stack trace available',
                interaction: {
                    type: interaction.type,
                    customId: interaction.customId,
                    user: interaction.user?.tag,
                    channel: interaction.channel?.name
                },
                state: interactionState
            });

            try {
                const errorMessage = '❌ An error occurred while processing your interaction.';
                
                if (!interactionState.replied) {
                    if (interactionState.deferred) {
                        await interaction.followUp({
                            content: errorMessage,
                            ephemeral: true,
                            allowedMentions: { users: [], roles: [] }
                        });
                    } else {
                        await interaction.reply({
                            content: errorMessage,
                            ephemeral: true,
                            allowedMentions: { users: [], roles: [] }
                        });
                    }
                    interactionState.replied = true;
                }
            } catch (replyError) {
                console.error('Failed to send error message:', {
                    error: replyError.message,
                    stack: replyError.stack,
                    originalError: error.message,
                    state: interactionState
                });
            }
        }
    }
}; 