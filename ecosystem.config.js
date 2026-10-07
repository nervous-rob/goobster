/**
 * PM2 process configuration (alternative to the systemd unit in deploy/).
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup   # persist across reboots
 *
 * PM2 runs the installation manager, which supervises this installation's
 * workers (bot, api, sandbox runner) as its own children and performs
 * staged restarts (documentation/manager_lifecycle.md). PM2 signals the
 * manager only (`treekill: false`); the manager stops each worker within
 * its bound (stop new work, at most 45 s of in-flight work, 15 s to exit),
 * so `kill_timeout` leaves room for that before PM2 forces anything.
 */
module.exports = {
    apps: [
        {
            name: 'goobster',
            script: 'apps/manager/index.js',
            args: '--supervise',
            instances: 1,
            exec_mode: 'fork',
            // Restart if memory exceeds Pi-friendly threshold (the manager
            // itself; its workers are not counted here)
            max_memory_restart: '200M',
            restart_delay: 10000,
            kill_timeout: 120000,
            treekill: false,
            env: {
                NODE_ENV: 'production',
                GOOBSTER_SUPERVISOR: 'pm2'
            },
            // Winston already writes rotating files under logs/; keep PM2's
            // own capture minimal.
            out_file: '/dev/null',
            error_file: '/dev/null',
            time: true
        }
        // Legacy: run the bot directly, without the manager. Exit code 75
        // still restarts it (PM2 restarts on any exit), but nothing performs
        // a staged restart, and slash commands deploy only via `npm start`.
        // {
        //     name: 'goobster',
        //     script: 'apps/bot/index.js',
        //     max_memory_restart: '900M',
        //     restart_delay: 10000,
        //     kill_timeout: 75000,
        //     env: { NODE_ENV: 'production', GOOBSTER_SUPERVISOR: 'pm2' }
        // }
    ]
};
