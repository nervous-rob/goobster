/**
 * Passphrase input for the backup and restore CLIs.
 *
 * Order of preference: --passphrase-file <path> (first line), the
 * GOOBSTER_BACKUP_PASSPHRASE environment variable (for unattended runs -
 * the runbook says where that leaves the secret), then an interactive
 * prompt with echo off. Nothing here stores the passphrase anywhere.
 */

const fs = require('node:fs');
const readline = require('node:readline');

/**
 * @param {Object} params
 * @param {string|null} [params.file]
 * @param {string} params.prompt
 * @param {boolean} [params.confirm=false] - ask twice (new passphrases)
 * @param {NodeJS.ProcessEnv} [params.env]
 * @returns {Promise<string|null>} null when no source is available
 */
async function readPassphrase({ file = null, prompt, confirm = false, env = process.env }) {
    if (file) {
        const text = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0];
        if (!text) throw new Error(`${file} is empty.`);
        return text;
    }
    if (env.GOOBSTER_BACKUP_PASSPHRASE) return env.GOOBSTER_BACKUP_PASSPHRASE;
    if (!process.stdin.isTTY) return null;
    const first = await promptHidden(prompt);
    if (!first) return null;
    if (confirm) {
        const second = await promptHidden('Repeat the passphrase: ');
        if (first !== second) throw new Error('The passphrases did not match.');
    }
    return first;
}

/** Prompt on the TTY with echo suppressed. */
function promptHidden(question) {
    return new Promise((resolve, reject) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
        let muted = false;
        const write = rl._writeToOutput.bind(rl);
        rl._writeToOutput = (text) => {
            if (muted) return;
            write(text);
        };
        rl.question(question, (answer) => {
            muted = false;
            process.stdout.write('\n');
            rl.close();
            resolve(answer);
        });
        muted = true;
        rl.on('error', reject);
    });
}

module.exports = { readPassphrase };
