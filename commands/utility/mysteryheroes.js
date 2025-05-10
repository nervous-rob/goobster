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
        .addBooleanOption(option =>
            option.setName('force_teamups')
                .setDescription('Reroll until every assigned hero has at least one potential team-up with someone else in the party')
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
        const forceTeamUps = interaction.options.getBoolean('force_teamups') || false;

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
        function generateOne() {
            // reset quotas and pools each attempt
            const quota = { ...roleQuota };
            const pools = {
                Vanguard: [...mutablePools.Vanguard],
                Duelist: [...mutablePools.Duelist],
                Strategist: [...mutablePools.Strategist]
            };
            const results = [];
            for (const member of players) {
                let availableRoles = ROLES.filter(r => quota[r] > 0);
                if (availableRoles.length === 0) availableRoles = ROLES;
                const role = randomFrom(availableRoles);
                quota[role] -= 1;

                let pool = pools[role];
                if (pool.length === 0) pool = [...HERO_POOLS[role]];
                const hero = randomFrom(pool);
                if (ensureUniqueHeroes) {
                    const idx = pool.indexOf(hero);
                    if (idx !== -1) pool.splice(idx, 1);
                    pools[role] = pool;
                }
                results.push({ member, role, hero });
            }
            return results;
        }

        // Helper to verify every hero has at least one team-up partner
        function allHeroesHaveTeamUp(assignmentsArray) {
            const heroes = assignmentsArray.map(a => a.hero);
            const heroSetLocal = new Set(heroes);
            for (const hero of heroes) {
                let ok = false;
                for (const [anchor, data] of Object.entries(module.exports.TEAM_UPS)) {
                    if (hero === anchor) {
                        if (data.partners.some(p => heroSetLocal.has(p))) { ok = true; break; }
                    }
                    if (data.partners.includes(hero)) {
                        if (heroSetLocal.has(anchor)) { ok = true; break; }
                    }
                }
                if (!ok) return false;
            }
            return true;
        }

        let assignments = generateOne();

        // ---------- Enhanced team-up search if initial attempts fail ----------
        if (forceTeamUps && !allHeroesHaveTeamUp(assignments)) {
            const edges = [];
            for (const [anchor, data] of Object.entries(module.exports.TEAM_UPS)) {
                for (const partner of data.partners) {
                    edges.push([anchor, partner]); // directional edge handled later
                }
            }

            // Attempt constructive assignment using edges
            const playersRemaining = [...players];
            const res = [];
            const quotaCopy = { ...roleQuota };
            const poolCopy = {
                Vanguard: [...HERO_POOLS.Vanguard],
                Duelist: [...HERO_POOLS.Duelist],
                Strategist: [...HERO_POOLS.Strategist]
            };

            function pickHero(role, hero) {
                // remove hero from pool if unique heroes requested
                if (ensureUniqueHeroes) {
                    for (const key of ROLES) {
                        const idx = poolCopy[key].indexOf(hero);
                        if (idx !== -1) poolCopy[key].splice(idx, 1);
                    }
                }
                // adjust quota
                if (quotaCopy[role] > 0) quotaCopy[role]--;
            }

            // Helper to pull hero from pools respecting role quota
            const pullHero = (desiredHero) => {
                // locate hero role
                for (const role of ROLES) {
                    if (poolCopy[role].includes(desiredHero) && quotaCopy[role] > 0) {
                        pickHero(role, desiredHero);
                        return role;
                    }
                }
                return null;
            };

            // Pure helper – check availability without mutating state
            const canPullHero = (desiredHero) => {
                for (const role of ROLES) {
                    if (poolCopy[role].includes(desiredHero) && quotaCopy[role] > 0) {
                        return true;
                    }
                }
                return false;
            };

            // Step 1: pair players using edges
            while (playersRemaining.length >= 2 && edges.length > 0) {
                const [p1, p2] = playersRemaining.splice(0, 2);
                // choose an edge that is still feasible without mutating state
                const candidateIndex = edges.findIndex(([a, b]) => canPullHero(a) && canPullHero(b));
                if (candidateIndex === -1) {
                    break; // no more feasible edge combos
                }
                const [h1, h2] = edges.splice(candidateIndex, 1)[0];
                const role1 = pullHero(h1);
                const role2 = pullHero(h2);
                if (role1 && role2) {
                    res.push({ member: p1, role: role1, hero: h1 });
                    res.push({ member: p2, role: role2, hero: h2 });
                } else {
                    // rollback if failed (should rarely happen)
                    if (role1) poolCopy[role1].push(h1);
                    if (role2) poolCopy[role2].push(h2);
                }
            }

            // Step 2: assign remaining players greedily ensuring they have partner in res
            while (playersRemaining.length) {
                const member = playersRemaining.shift();
                // Try to find hero that teams up with someone already assigned
                let assigned = false;
                outer: for (const existing of res) {
                    const exHero = existing.hero;
                    // can exHero be anchor for something? check map both ways
                    const tuples = [];
                    if (module.exports.TEAM_UPS[exHero]) {
                        tuples.push(...module.exports.TEAM_UPS[exHero].partners.map(p => [exHero, p]));
                    }
                    for (const [anchor, data] of Object.entries(module.exports.TEAM_UPS)) {
                        if (data.partners.includes(exHero)) {
                            tuples.push([anchor, exHero]);
                        }
                    }
                    for (const [aHero, bHero] of tuples) {
                        const candidateHero = aHero === exHero ? bHero : aHero;
                        const role = pullHero(candidateHero);
                        if (role) {
                            res.push({ member, role, hero: candidateHero });
                            assigned = true;
                            break outer;
                        }
                    }
                }
                if (!assigned) {
                    // fallback: any hero respecting quotas
                    for (const role of ROLES) {
                        if (quotaCopy[role] > 0 && poolCopy[role].length) {
                            const hero = poolCopy[role].shift();
                            pickHero(role, hero);
                            res.push({ member, role, hero });
                            break;
                        }
                    }
                }
            }

            assignments = res;

            // final validation
            if (!allHeroesHaveTeamUp(assignments)) {
                await interaction.followUp({ content: '⚠️ Generated roster still lacks full team-up coverage. Consider reducing constraints or party size.', ephemeral: true });
            }
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

        // ---------------------- Detect possible Team-Ups ----------------------
        const heroSet = new Set(assignments.map(a => a.hero));
        const teamUpMessages = [];
        for (const [anchor, data] of Object.entries(module.exports.TEAM_UPS)) {
            if (!heroSet.has(anchor)) continue;
            const partnersPresent = data.partners.filter(p => heroSet.has(p));
            if (partnersPresent.length > 0) {
                const combos = [anchor, ...partnersPresent].join(' + ');
                teamUpMessages.push(`• ${data.name}: ${combos}`);
            }
        }

        if (teamUpMessages.length > 0) {
            embed.addFields({ name: '🤝 Potential Team-Ups', value: teamUpMessages.join('\n') });
        }

        return interaction.editReply({ embeds: [embed] });
    }
};

// ------------------------------ TEAM-UP DETECTION ------------------------------
// Mapping of Anchor Hero ➜ { name: Team-Up Name, partners: [] }
// NOTE: Keep this list in sync with game patches where possible.
module.exports.TEAM_UPS = {
    'Hawkeye': { name: 'Allied Agents', partners: ['Black Widow'] },
    'Rocket Raccoon': { name: 'Ammo Overload', partners: ['The Punisher'] },
    'Doctor Strange': { name: 'Arcane Order', partners: ['Scarlet Witch'] },
    'Iron Fist': { name: 'Atlas Bond', partners: ['Luna Snow'] },
    'Luna Snow': { name: 'Chilling Charisma', partners: ['Jeff the Land Shark'] },
    'Magik': { name: 'Dimensional Shortcut', partners: ['Black Panther'] },
    'Invisible Woman': { name: 'Fantastic Four', partners: ['Mister Fantastic', 'The Thing', 'Human Torch'] },
    'Wolverine': { name: 'Fastball Special', partners: ['Hulk', 'The Thing'] },
    'Hulk': { name: 'Gamma Charge', partners: ['Iron Man', 'Namor'] },
    'Adam Warlock': { name: 'Guardian Revival', partners: ['Mantis', 'Star-Lord'] },
    'Cloak & Dagger': { name: 'Lunar Force', partners: ['Moon Knight'] },
    'Emma Frost': { name: 'Mental Projection', partners: ['Magneto', 'Psylocke'] },
    'Groot': { name: 'Planet X Pals', partners: ['Jeff the Land Shark', 'Rocket Raccoon'] },
    'Hela': { name: 'Ragnarok Rebirth', partners: ['Loki', 'Thor'] },
    'Captain America': { name: 'Stars Aligned', partners: ['Winter Soldier'] },
    'Storm': { name: 'Storming Ignition', partners: ['Human Torch'] },
    'Venom': { name: 'Symbiote Bond', partners: ['Spider-Man', 'Peni Parker'] },
    'Spider-Man': { name: 'ESU Alumnus', partners: ['Squirrel Girl'] },
}; 