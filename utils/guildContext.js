const { getBotNickname, getUserNickname } = require('./guildSettings');

/**
 * Gets enriched context about a guild including statistics and member information
 * @param {Discord.Guild|null} guild - The Discord guild (can be null in DMs)
 * @returns {Promise<Object>} - Guild context object
 */
async function getGuildContext(guild) {
    try {
        // Check if guild exists (will be null in DMs)
        if (!guild) {
            return {
                name: "Direct Message",
                memberCount: 2,
                botNickname: "Goobster",
                owner: "User",
                features: [],
                channels: {
                    total: 1,
                    text: 1,
                    voice: 0
                },
                presences: {
                    online: 2,
                    idle: 0,
                    dnd: 0,
                    offline: 0
                }
            };
        }

        // Get basic guild info
        const guildInfo = {
            name: guild.name,
            memberCount: guild.memberCount,
            botNickname: await getBotNickname(guild.id),
            owner: guild.members?.cache?.get(guild.ownerId)?.displayName || 'Unknown',
            features: guild.features || [],
            channels: {
                total: guild.channels?.cache?.size || 0,
                text: guild.channels?.cache?.filter(c => c.type === 0)?.size || 0,
                voice: guild.channels?.cache?.filter(c => c.type === 2)?.size || 0
            }
        };

        // Get online member stats with null checks
        let onlineMembers = 0;
        let idleMembers = 0;
        let dndMembers = 0;
        
        if (guild.members?.cache) {
            onlineMembers = guild.members.cache.filter(m => m.presence?.status === 'online').size;
            idleMembers = guild.members.cache.filter(m => m.presence?.status === 'idle').size;
            dndMembers = guild.members.cache.filter(m => m.presence?.status === 'dnd').size;
        }
        
        const offlineMembers = guild.memberCount - onlineMembers - idleMembers - dndMembers;

        guildInfo.presences = {
            online: onlineMembers,
            idle: idleMembers,
            dnd: dndMembers,
            offline: offlineMembers
        };

        return guildInfo;
    } catch (error) {
        console.error('Error getting guild context:', error);
        // Return a minimal context object rather than null
        return {
            name: guild?.name || "Unknown Server",
            memberCount: guild?.memberCount || 0,
            botNickname: "Goobster",
            owner: "Unknown",
            features: [],
            channels: { total: 0, text: 0, voice: 0 },
            presences: { online: 0, idle: 0, dnd: 0, offline: 0 }
        };
    }
}

/**
 * Gets the most appropriate name to use for a user in a guild
 * @param {string} userId - The Discord user ID
 * @param {string|null} guildId - The Discord guild ID (can be null in DMs)
 * @param {Discord.GuildMember|null} member - The guild member object (can be null in DMs)
 * @returns {Promise<string>} - The name to use
 */
async function getPreferredUserName(userId, guildId, member) {
    try {
        // If no guildId (in DMs), just use the username
        if (!guildId) {
            return member?.user?.username || 'User';
        }

        // First check if user has set a custom nickname through our command
        const customNick = await getUserNickname(userId, guildId);
        if (customNick) return customNick;

        // Then check if user has a server nickname
        if (member?.nickname) return member.nickname;

        // Finally fall back to their username
        return member?.user?.username || 'User';
    } catch (error) {
        console.error('Error getting preferred user name:', error);
        return member?.user?.username || 'User';
    }
}

/**
 * Gets the bot's preferred name in a guild
 * @param {string|null} guildId - The Discord guild ID (can be null in DMs)
 * @param {Discord.GuildMember|null} botMember - The bot's guild member object (can be null in DMs)
 * @returns {Promise<string>} - The name to use
 */
async function getBotPreferredName(guildId, botMember) {
    try {
        // If no guildId (in DMs), just use the default name
        if (!guildId) {
            return 'Goobster';
        }

        // First check if there's a custom nickname set through our command
        const customNick = await getBotNickname(guildId);
        if (customNick) return customNick;

        // Then check if there's a server nickname
        if (botMember?.nickname) return botMember.nickname;

        // Finally fall back to the default name
        return 'Goobster';
    } catch (error) {
        console.error('Error getting bot preferred name:', error);
        return 'Goobster';
    }
}

module.exports = {
    getGuildContext,
    getPreferredUserName,
    getBotPreferredName
}; 