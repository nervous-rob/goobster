const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');

/**
 * Marvel Rivals – Mystery Heroes Role Assignment
 * ------------------------------------------------
 * This command randomly assigns a Marvel Rivals role (Vanguard, Duelist, Strategist)
 * and a matching hero to every non-bot user currently in the caller's voice channel.
 *
 * Options:
 * • unique_roles  –  Prevent more than the recommended number of each role (2-2-2 for six players).
 * • unique_heroes –  Ensure no duplicate heroes are handed out (falls back to duplicates if we run out).
 *
 * If the user is not connected to a voice channel the bot responds with an error message.
 * The assignments are returned as a rich embed for readability.
 *
 * NOTE:  This command is intentionally simple – it does not track state between calls and
 *        relies only on the current voice channel membership.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('mysteryheroes')
        .setDescription('Randomly assign Marvel Rivals roles (and heroes) to everyone in your voice channel')
        .addBooleanOption(option =>
            option.setName('unique_roles')
                .setDescription('Try to keep a 2-2-2 role split (requires ≥ 6 players)')
                .setRequired(false))
        .addBooleanOption(option =>
            option.setName('unique_heroes')
                .setDescription('Ensure no duplicate heroes if possible')
                .setRequired(false))
        .setDMPermission(false),

    async execute(interaction) {
        await interaction.deferReply();

        // Validate voice presence ----------------------------------------------------
        const voiceChannel = interaction.member.voice?.channel;
        if (!voiceChannel) {
            return interaction.editReply('❌ You need to be in a voice channel to use this command.');
        }

        // Ensure the bot can at least view the channel (CONNECT not needed – we don't join)
        const permissions = voiceChannel.permissionsFor(interaction.client.user);
        if (!permissions || !permissions.has(PermissionFlagsBits.ViewChannel)) {
            return interaction.editReply('❌ I cannot see that voice channel. Please adjust my permissions.');
        }

        // Filter out bots -------------------------------------------------------------
        const players = [...voiceChannel.members.values()].filter(m => !m.user.bot);
        if (players.length === 0) {
            return interaction.editReply('No human players detected in the channel.');
        }

        // Input flags -----------------------------------------------------------------
        const ensureUniqueRoles = interaction.options.getBoolean('unique_roles') || false;
        const ensureUniqueHeroes = interaction.options.getBoolean('unique_heroes') || false;

        // Data sets -------------------------------------------------------------------
        const HERO_POOLS = {
            Vanguard: [
                'Doctor Strange', 'Hulk', 'Groot', 'Peni Parker', 'Magneto', 'Venom',
                'Captain America', 'Thor', 'Emma Frost', 'The Thing'
            ],
            Duelist: [
                'Black Panther', 'Black Widow', 'Hawkeye', 'Hela', 'Human Torch', 'Iron Fist',
                'Iron Man', 'Magik', 'Mister Fantastic', 'Moon Knight', 'Namor', 'Psylocke',
                'Scarlet Witch', 'Spider-Man', 'Squirrel Girl', 'Star-Lord', 'Storm',
                'The Punisher', 'Winter Soldier', 'Wolverine'
            ],
            Strategist: [
                'Adam Warlock', 'Cloak & Dagger', 'Invisible Woman', 'Jeff the Land Shark',
                'Loki', 'Luna Snow', 'Mantis', 'Rocket Raccoon'
            ]
        };
        const ROLES = Object.keys(HERO_POOLS);

        // Helper – get random element -------------------------------------------------
        const randomFrom = array => array[Math.floor(Math.random() * array.length)];

        // Build role quota if unique_roles requested ----------------------------------
        const roleQuota = {
            Vanguard: Infinity,
            Duelist: Infinity,
            Strategist: Infinity
        };
        if (ensureUniqueRoles && players.length >= 6) {
            // Classic 2-2-2 split – cap each role to 2
            roleQuota.Vanguard = 2;
            roleQuota.Duelist = 2;
            roleQuota.Strategist = 2;
        }

        // Clone hero pools so we can mutate safely ------------------------------------
        const mutablePools = {
            Vanguard: [...HERO_POOLS.Vanguard],
            Duelist: [...HERO_POOLS.Duelist],
            Strategist: [...HERO_POOLS.Strategist]
        };

        // Assignment ------------------------------------------------------------------
        const assignments = [];
        for (const member of players) {
            // Pick role under current constraints ------------------------------------
            let availableRoles = ROLES.filter(r => roleQuota[r] > 0);
            if (availableRoles.length === 0) {
                // All quotas filled – reset to allow any further duplicates
                availableRoles = ROLES;
            }
            const role = randomFrom(availableRoles);
            roleQuota[role] = roleQuota[role] - 1;

            // Pick hero from that role pool -----------------------------------------
            let pool = mutablePools[role];
            if (pool.length === 0) {
                // Refill if we ran out (duplicates now allowed)
                pool = [...HERO_POOLS[role]];
            }
            const hero = randomFrom(pool);
            if (ensureUniqueHeroes) {
                // Remove hero to avoid duplicate
                const index = pool.indexOf(hero);
                if (index !== -1) pool.splice(index, 1);
                mutablePools[role] = pool;
            }

            assignments.push({ member, role, hero });
        }

        // Build embed -----------------------------------------------------------------
        const embed = new EmbedBuilder()
            .setColor('#e61025')
            .setTitle('🦸 Mystery Heroes – Marvel Rivals')
            .setDescription(`Random assignments for **${players.length}** player${players.length > 1 ? 's' : ''} in <#${voiceChannel.id}>:`)
            .setFooter({ text: 'Good luck and have fun!' });

        for (const { member, role, hero } of assignments) {
            embed.addFields({ name: member.displayName || member.user.username, value: `**${role}** → ${hero}`, inline: true });
        }

        return interaction.editReply({ embeds: [embed] });
    }
}; 