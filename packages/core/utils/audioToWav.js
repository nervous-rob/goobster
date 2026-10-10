const { spawn } = require('node:child_process');

/** Convert a browser clip to the WAV format accepted by completions audio input. */
function audioToWav(buffer) {
    return new Promise((resolve, reject) => {
        const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1']);
        const chunks = [];
        let bytes = 0;
        let failure = null;
        const fail = () => { failure = new Error('Could not convert this recording to WAV.'); child.kill('SIGKILL'); };
        const timer = setTimeout(fail, 30000);
        child.stdout.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > 25 * 1024 * 1024) fail(); else chunks.push(chunk);
        });
        child.stderr.resume();
        child.stdin.on('error', () => { /* process exit is handled below */ });
        child.on('error', () => { clearTimeout(timer); reject(new Error('Audio conversion needs ffmpeg installed on this host.')); });
        child.on('close', code => {
            clearTimeout(timer);
            if (failure || code !== 0 || !bytes) reject(failure || new Error('Could not convert this recording to WAV.'));
            else resolve(Buffer.concat(chunks));
        });
        child.stdin.end(buffer);
    });
}
module.exports = { audioToWav };
