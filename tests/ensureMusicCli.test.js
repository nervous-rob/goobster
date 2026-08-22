const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const helperPath = path.join(repoRoot, 'scripts', 'ensure-music-cli.sh');
const installerPath = path.join(repoRoot, 'scripts', 'install-rpi.sh');

describe('ensure-music-cli.sh', () => {
    const helper = fs.readFileSync(helperPath, 'utf8');
    const installer = fs.readFileSync(installerPath, 'utf8');

    test('is executable and lives next to the Pi installer', () => {
        expect(fs.statSync(helperPath).mode & 0o111).toBeTruthy();
    });

    test('treats a missing venv or either CLI as unhealthy', () => {
        expect(helper).toMatch(/bin\/spotdl/);
        expect(helper).toMatch(/bin\/yt-dlp/);
        expect(helper).toMatch(/python3 -m venv --clear/);
        expect(helper).toMatch(/pip" install --no-cache-dir --upgrade pip yt-dlp spotdl/);
    });

    test('install-rpi.sh calls the helper on full install and on --update', () => {
        expect(installer).toMatch(/scripts\/ensure-music-cli\.sh/);
        expect(installer).toMatch(/UPDATE_ONLY/);
        // Regression: --update used to skip a *missing* venv (`[[ -d VENV_DIR ]]`).
        expect(installer).not.toMatch(/if \[\[ -d "\$\{VENV_DIR\}" \]\] && ! "\$\{VENV_DIR\}\/bin\/spotdl"/);
    });
});
