'use strict';

const fs = require('node:fs');
const https = require('node:https');

/** HTTPS GET with redirects to a file (written to `<file>.part`, then renamed). */
function download(url, destination) {
    return new Promise((resolve, reject) => {
        const request = (current, redirects) => {
            https.get(current, { headers: { 'User-Agent': 'goobster-package-tools' } }, (response) => {
                if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
                    response.resume();
                    if (redirects > 5) return reject(new Error('too many redirects'));
                    return request(new URL(response.headers.location, current).toString(), redirects + 1);
                }
                if (response.statusCode !== 200) {
                    response.resume();
                    const error = new Error(`GET ${current} -> HTTP ${response.statusCode}`);
                    error.statusCode = response.statusCode;
                    return reject(error);
                }
                const partial = `${destination}.part`;
                const out = fs.createWriteStream(partial);
                response.pipe(out);
                out.on('finish', () => out.close(() => {
                    fs.renameSync(partial, destination);
                    resolve();
                }));
                out.on('error', reject);
                response.on('error', reject);
                return undefined;
            }).on('error', reject);
        };
        request(url, 0);
    });
}

module.exports = { download };
