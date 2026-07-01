const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const db = require('../../db');
const aiService = require('../../services/aiService');

/**
 * Read the SoC temperature. Works on Raspberry Pi (and most Linux SBCs)
 * via /sys/class/thermal; returns null on other platforms.
 * @returns {number|null} Temperature in °C
 */
function readCpuTemperature() {
    try {
        const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8');
        return Math.round(parseInt(raw, 10) / 100) / 10;
    } catch {
        return null;
    }
}

/**
 * Check whether the Raspberry Pi firmware reports throttling.
 * Bits: 0 under-voltage, 1 arm freq capped, 2 currently throttled.
 * @returns {string|null}
 */
function readThrottleState() {
    try {
        const raw = fs.readFileSync('/sys/devices/platform/soc/soc:firmware/get_throttled', 'utf8').trim();
        const value = parseInt(raw, 16);
        if (Number.isNaN(value)) return null;
        if (value === 0) return 'No throttling';
        const issues = [];
        if (value & 0x1) issues.push('under-voltage');
        if (value & 0x2) issues.push('frequency capped');
        if (value & 0x4) issues.push('throttled');
        if (value & 0x8) issues.push('soft temp limit');
        return issues.length ? `⚠️ ${issues.join(', ')}` : 'No throttling';
    } catch {
        return null;
    }
}

/**
 * Format seconds as a human readable duration.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h) parts.push(`${h}h`);
    parts.push(`${m}m`);
    return parts.join(' ');
}

/**
 * Format bytes as MB/GB.
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    const mb = bytes / (1024 * 1024);
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;
}

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
            const throttle = readThrottleState();

            // Database stats
            let dbInfo = 'Unavailable';
            try {
                const pageCount = db.getDb().pragma('page_count', { simple: true });
                const pageSize = db.getDb().pragma('page_size', { simple: true });
                const messageCount = db.get('SELECT COUNT(*) AS count FROM messages').count;
                dbInfo = `${formatBytes(pageCount * pageSize)} on disk, ${messageCount} messages`;
            } catch (dbError) {
                console.error('Error reading database stats:', dbError);
            }

            // Disk usage for the data directory
            let diskInfo = 'Unavailable';
            try {
                const stats = fs.statfsSync(path.join(__dirname, '..', '..'));
                const total = stats.blocks * stats.bsize;
                const free = stats.bavail * stats.bsize;
                diskInfo = `${formatBytes(total - free)} used / ${formatBytes(total)} (${formatBytes(free)} free)`;
            } catch {
                // statfsSync unavailable on this platform
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
