/**
 * PM2 process configuration (alternative to the systemd unit in deploy/).
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup   # persist across reboots
 */
module.exports = {
    apps: [
        {
            name: 'goobster',
            script: 'index.js',
            instances: 1,
            exec_mode: 'fork',
            // Restart if memory exceeds Pi-friendly threshold
            max_memory_restart: '900M',
            restart_delay: 10000,
            env: {
                NODE_ENV: 'production'
            },
            // Winston already writes rotating files under logs/; keep PM2's
            // own capture minimal.
            out_file: '/dev/null',
            error_file: '/dev/null',
            time: true
        }
    ]
};
