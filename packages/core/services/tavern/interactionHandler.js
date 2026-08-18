const { TavernError } = require('./tavernError');
const adventureService = require('./adventureService');
const questLoader = require('./questLoader');
const narrator = require('./narrator');
const views = require('../../utils/tavernViews');

/**
 * Button handling for the Tavern (routed from events/interactionCreate.js,
 * customId scheme: <action>_tavern_<id>[-<optionKey>]). All game state lives
 * in SQLite, so buttons keep working across restarts - a stale click gets a
 * polite ephemeral note, never a crash.
 */

/**
 * Render the current scene message payload for an adventure.
 * @param {number} adventureId
 * @param {string|null} lead - optional lead-in line above the scene text
 */
async function buildSceneView(adventureId, lead = null) {
    const { adventure, quest, scene, members } = await adventureService.describe(adventureId);
    const assetService = require('./assetService');
    const enemies = adventureService.livingEnemies(adventure, quest);
    const telegraphs = Object.fromEntries(enemies.map(enemy =>
        [enemy.id, adventureService.telegraphedIntent(adventure, enemy)]));
    return views.sceneMessage({
        adventure, quest, scene, members,
        options: adventureService.availableOptions(adventure, quest),
        spotlightUserId: adventureService.spotlightUser(adventure),
        lead,
        // Twist forks reuse the canonical campaign's art
        artPath: scene ? assetService.getSceneArt(quest.canonicalId || quest.id, scene.id) : null,
        enemies,
        telegraphs
    });
}

/**
 * Send the completion flow for an ended adventure: the ending embed, with an
 * optional AI-polished retelling (graceful fallback to none).
 */
async function sendEnding(channel, quest, ended, guildId) {
    let polishedRecap = null;
    try {
        const recap = await adventureService.getLatestRecap(guildId, channel.id);
        if (recap) polishedRecap = await narrator.polishRecap(recap.content, { guildId, userId: null });
    } catch {
        polishedRecap = null;
    }
    await channel.send({ embeds: [views.endingMessage(quest, ended, { polishedRecap })] });
}

/**
 * Handle a tavern button click.
 * @param {string} action - join | begin | opt | spark
 * @param {string} requestId - "<adventureId>" or "<adventureId>-<optionKey>"
 * @param {Object} interaction
 */
async function handleButton(action, requestId, interaction) {
    const [idPart, ...optionParts] = String(requestId).split('-');
    const adventureId = Number(idPart);
    const optionKey = optionParts.join('-');
    const userId = interaction.user.id;

    try {
        if (action === 'join') {
            const { adventure, quest, members } = await adventureService.join(adventureId, userId);
            await interaction.update(views.partyMessage(adventure, quest, members));
            return;
        }

        if (action === 'begin') {
            const { adventure, quest, members } = await adventureService.begin(adventureId, userId);
            // Retire the recruiting card's buttons and post the opening scene
            const startedEmbed = views.partyMessage(adventure, quest, members).embeds[0]
                .setFooter({ text: 'The adventure is underway!' });
            await interaction.update({ embeds: [startedEmbed], components: [] });
            await interaction.channel.send(await buildSceneView(adventureId, '*The tale begins.*'));
            await require('./botAdventurer').maybeTakeTurn(adventureId, interaction.channel);
            return;
        }

        if (action === 'opt' || action === 'atk') {
            const result = action === 'atk'
                ? await adventureService.attack(adventureId, userId, optionKey)
                : await adventureService.chooseOption(adventureId, userId, optionKey);
            const outcome = views.checkResultMessage(result, adventureId);

            if (result.ended || result.sceneChanged) {
                // The old scene is over: strip its buttons, post the outcome,
                // then the next scene (or the ending).
                await interaction.update({ components: [] });
                await interaction.channel.send(outcome);
                if (result.ended) {
                    const quest = questLoader.getQuest(result.adventure.questId);
                    await sendEnding(interaction.channel, quest, result.ended, result.adventure.guildId);
                } else {
                    await interaction.channel.send(await buildSceneView(adventureId));
                }
            } else {
                // Same scene: refresh it in place (clocks, party, remaining
                // options) and post the outcome below. attachments: [] keeps
                // re-attached scene art from stacking up on the message.
                await interaction.update({ ...await buildSceneView(adventureId), attachments: [] });
                await interaction.followUp(outcome);
            }
            // If Goobster is in the party and the spotlight reached him, he plays
            await require('./botAdventurer').maybeTakeTurn(adventureId, interaction.channel);
            return;
        }

        if (action === 'spark') {
            const result = await adventureService.sparkReroll(adventureId, userId);
            // The reroll consumed this button - remove it from the old outcome
            await interaction.update({ components: [] });
            await interaction.channel.send(views.checkResultMessage(result, adventureId));
            if (result.ended) {
                const quest = questLoader.getQuest(result.adventure.questId);
                await sendEnding(interaction.channel, quest, result.ended, result.adventure.guildId);
            } else if (result.sceneChanged) {
                await interaction.channel.send(await buildSceneView(adventureId));
            }
            await require('./botAdventurer').maybeTakeTurn(adventureId, interaction.channel);
            return;
        }

        await interaction.reply({ content: 'That button has wandered off the menu.', ephemeral: true });
    } catch (error) {
        const message = error instanceof TavernError
            ? `🍺 ${error.message}`
            : '❌ The Tavern hit a snag handling that.';
        if (!(error instanceof TavernError)) console.error('Tavern button error:', error);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp({ content: message, ephemeral: true });
            } else {
                await interaction.reply({ content: message, ephemeral: true });
            }
        } catch (replyError) {
            console.error('Failed to deliver tavern button error:', replyError);
        }
    }
}

module.exports = { handleButton, buildSceneView, sendEnding };
