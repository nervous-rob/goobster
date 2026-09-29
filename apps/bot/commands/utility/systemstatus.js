const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const os = require('node:os');
const db = require('@goobster/core/db');
const aiService = require('@goobster/core/services/aiService');
const {
    readCpuTemperature,
    readThrottleFlags,
    describeThrottle,
    formatDuration,
    formatBytes,
    readDiskUsage,
    readDatabaseStats
} = require('@goobster/core/utils/hostHealth');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('systemstatus')
        .setDescription('Show host system health: CPU, memory, temperature, disk, and bot stats.'),
    async execute(interaction) {
        await interaction.deferReply();

        try {
            // System metrics
            const load = os.loadavg();
            const cpuCount = os.cpus().length;
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMem = totalMem - freeMem;
            const processMem = process.memoryUsage();
            const temperature = readCpuTemperature();
            const throttle = describeThrottle(readThrottleFlags());

            let dbInfo = 'Unavailable';
            const dbStats = await readDatabaseStats(db);
            if (dbStats) {
                dbInfo = dbStats.engine === 'postgres'
                    ? `${formatBytes(dbStats.bytes || 0)} (Postgres), ${dbStats.messageCount} messages`
                    : `${formatBytes(dbStats.bytes || 0)} on disk, ${dbStats.messageCount} messages`;
            }

            let diskInfo = 'Unavailable';
            const disk = readDiskUsage(require('@goobster/core/runtimePaths').dataDir);
            if (disk) {
                diskInfo = `${formatBytes(disk.usedBytes)} used / ${formatBytes(disk.totalBytes)} (${formatBytes(disk.freeBytes)} free)`;
            }

            const embed = new EmbedBuilder()
                .setColor(temperature && temperature > 70 ? '#FF4500' : '#43B581')
                .setTitle('🖥️ System Status')
                .addFields(
                    {
                        name: 'Host',
                        value: [
                            `**OS:** ${os.type()} ${os.release()} (${os.arch()})`,
                            `**Uptime:** ${formatDuration(os.uptime())}`,
                            `**Load:** ${load.map(l => l.toFixed(2)).join(' / ')} (${cpuCount} cores)`,
                            temperature !== null ? `**CPU Temp:** ${temperature}°C` : null,
                            throttle ? `**Throttle:** ${throttle}` : null
                        ].filter(Boolean).join('\n'),
                        inline: false
                    },
                    {
                        name: 'Memory',
                        value: [
                            `**System:** ${formatBytes(usedMem)} / ${formatBytes(totalMem)} (${Math.round((usedMem / totalMem) * 100)}%)`,
                            `**Bot RSS:** ${formatBytes(processMem.rss)}`,
                            `**Heap:** ${formatBytes(processMem.heapUsed)} / ${formatBytes(processMem.heapTotal)}`
                        ].join('\n'),
                        inline: false
                    },
                    {
                        name: 'Bot',
                        value: [
                            `**Process uptime:** ${formatDuration(process.uptime())}`,
                            `**Gateway ping:** ${Math.round(interaction.client.ws.ping)}ms`,
                            `**Guilds:** ${interaction.client.guilds.cache.size}`,
                            `**AI provider:** ${aiService.getProvider()}${aiService.getDefaultModel() ? ` (${aiService.getDefaultModel()})` : ''}`,
                            `**Database:** ${dbInfo}`,
                            `**Disk:** ${diskInfo}`
                        ].join('\n'),
                        inline: false
                    }
                )
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });
        } catch (error) {
            console.error('Error building system status:', error);
            await interaction.editReply('❌ Failed to gather system status.');
        }
    },
};
