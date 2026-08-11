# Continuous Deployment (Raspberry Pi)

Keep a self-hosted Goobster in sync with `main`: when a pull request is merged,
the Pi notices within a few minutes, stops the bot, fast-forwards the working
copy, reinstalls dependencies, reloads systemd, and starts the service again.
If the new commit does not come back healthy, the Pi rolls itself back to the
commit it was running before.

Everything is in the repo:

| File | Role |
| --- | --- |
| `scripts/auto-update.sh` | The updater: detect, stop, pull, install, reload, restart, verify, roll back |
| `deploy/goobster-update.service` | One-shot systemd unit that runs the updater as root |
| `deploy/goobster-update.timer` | Polls the deploy branch every 5 minutes |
| `deploy/goobster-update.conf.example` | Template for `/etc/goobster-update.conf` |
| `scripts/install-rpi.sh --update` | The reinstall step (no apt, no sudo, no Python venv) |

## Why polling instead of a webhook

A Pi on a home network usually has no public address, so GitHub cannot call it.
A systemd timer that asks GitHub "has `main` moved?" every 5 minutes needs no
open ports, no tunnel, and no secrets, and it recovers on its own after the Pi
has been offline. If you want deploys to start within seconds of a merge, see
[Push triggers](#push-triggers) — the same updater is used either way.

## Setup

On a Pi that already runs Goobster under systemd (`goobster.service`):

```bash
cd ~/goobster
git pull
./scripts/install-rpi.sh --auto-update
```

That installs `goobster-update.service` and `goobster-update.timer` with your
repo path substituted in, writes `/etc/goobster-update.conf` from the template,
and enables the timer. On a brand new Pi, `./scripts/install-rpi.sh --service
--auto-update` does the full install and both units in one pass.

Manual equivalent:

```bash
sudo cp deploy/goobster-update.service deploy/goobster-update.timer /etc/systemd/system/
sudo cp deploy/goobster-update.conf.example /etc/goobster-update.conf
sudoedit /etc/goobster-update.conf          # repo dir, user, branch, options
sudo systemctl daemon-reload
sudo systemctl enable --now goobster-update.timer
```

Check that it is armed and try one deploy by hand:

```bash
systemctl list-timers goobster-update.timer
sudo ./scripts/auto-update.sh --check       # exit 10 = a deploy is pending
sudo systemctl start goobster-update        # run one deploy now
journalctl -u goobster-update -f
```

The working copy must be a clone the bot user owns, tracking a remote branch
(`origin/main` by default). For a private repository, give the Pi a read-only
deploy key and clone over SSH; nothing else changes.

## What one deploy does

1. `git fetch origin main` as the repo owner, and compare `HEAD` with
   `origin/main`. Identical means the run ends here — the common case.
2. Optionally wait for GitHub checks on the target commit to pass
   (`GOOBSTER_REQUIRE_CI=true`).
3. Take a lock so two runs can never overlap, then `systemctl stop goobster`.
4. `git reset --hard origin/main`.
5. Run the install step, `scripts/install-rpi.sh --update` by default:
   `npm ci --omit=dev` (with the ARM64 opus build flag), recreate the runtime
   directories, and apply `db/schema.sql` through `node initDb.js`.
6. `systemctl daemon-reload`, then `systemctl start goobster`.
7. Poll `http://127.0.0.1:3000/health` until it answers, up to
   `GOOBSTER_HEALTH_TIMEOUT` seconds. `goobster.service` runs
   `deploy-commands.js` as `ExecStartPre`, so the first probe usually lands a
   few seconds after the start.
8. On failure: stop, `git reset --hard` back to the previous commit, reinstall,
   start, verify. The bot ends the run on the last commit known to boot.

`git reset --hard` is what makes step 4 reliable on an unattended box, so treat
the Pi's working copy as read-only: local commits and local edits to tracked
files are discarded. Untracked and gitignored files are left alone —
`config.json`, `data/`, `cache/`, and `logs/` survive every deploy (`git clean`
only runs when you set `GOOBSTER_GIT_CLEAN=true`, and never with `-x`).

Exit codes: `0` up to date or deployed, `1` deploy failed and was rolled back,
`2` deploy failed and the rollback also failed (the bot is down and needs a
human), `10` `--check` found a pending deploy.

## Configuration

`/etc/goobster-update.conf` is read both by systemd and by the script; command
line flags override it. See `deploy/goobster-update.conf.example` for the full
annotated list.

| Setting | Default | Notes |
| --- | --- | --- |
| `GOOBSTER_REPO_DIR` | parent of the script | Working copy to deploy |
| `GOOBSTER_RUN_USER` | owner of the repo dir | git and npm run as this user |
| `GOOBSTER_BRANCH` / `GOOBSTER_REMOTE` | `main` / `origin` | Deploy branch |
| `GOOBSTER_SERVICE` | `goobster` | systemd unit to restart |
| `GOOBSTER_INSTALL_CMD` | `scripts/install-rpi.sh --update` | Any command, run from the repo root |
| `GOOBSTER_HEALTH_URL` | `http://127.0.0.1:3000/health` | Empty = only require the unit to stay active |
| `GOOBSTER_HEALTH_TIMEOUT` | `180` | Seconds to wait for a healthy bot |
| `GOOBSTER_ROLLBACK` | `true` | `false` leaves a broken deploy in place |
| `GOOBSTER_REQUIRE_CI` | `false` | Only deploy commits whose GitHub checks passed |
| `GOOBSTER_GITHUB_TOKEN` | unset | For private repos or API rate limits |
| `GOOBSTER_SYNC_UNIT` | `false` | Reinstall `goobster.service` when it changes upstream |
| `GOOBSTER_DISCORD_WEBHOOK` | unset | Deploy notifications to a channel |

### Gate deploys on CI

`.github/workflows/ci.yml` runs lint, smoke, and Jest on every push to `main`.
With `GOOBSTER_REQUIRE_CI=true` the Pi asks the GitHub checks API about the
target commit and only deploys when every check run has finished successfully;
while CI is still running the deploy simply waits for the next tick. This is
worth enabling — it is the difference between "merged" and "merged and green".

### Get notified

Set `GOOBSTER_DISCORD_WEBHOOK` to a channel webhook URL to receive a message
per deploy: the new commit and its subject on success, and a loud one when a
deploy was rolled back or the rollback failed.

## Push triggers

The timer is the floor, not the ceiling. Anything that runs
`sudo systemctl start goobster-update` on the Pi starts a deploy immediately,
and the lock keeps it from colliding with a scheduled run.

- **Poll faster.** Drop `OnUnitActiveSec` in the timer to `1min`. GitHub's
  unauthenticated API allows 60 requests an hour, and only the CI gate calls the
  API at all, so a 1-minute poll is fine.
- **Tailscale (or any VPN) + GitHub Actions.** Put the Pi on your tailnet, then
  add a workflow that runs after CI succeeds on `main` and SSHes in:

  ```yaml
  name: Deploy to Pi
  on:
    workflow_run:
      workflows: [CI]
      types: [completed]
      branches: [main]
  jobs:
    deploy:
      if: github.event.workflow_run.conclusion == 'success'
      runs-on: ubuntu-latest
      steps:
        - uses: tailscale/github-action@v3
          with:
            oauth-client-id: ${{ secrets.TS_OAUTH_CLIENT_ID }}
            oauth-secret: ${{ secrets.TS_OAUTH_SECRET }}
            tags: tag:ci
        - run: ssh -o StrictHostKeyChecking=no pi@goobster-pi 'sudo systemctl start goobster-update'
  ```

- **Cloudflare tunnel.** If you already expose the bot for Discord Activities
  (`documentation/activity_setup.md`), a GitHub webhook can reach the Pi; have
  your receiver run `systemctl start goobster-update`, which needs a sudoers
  entry for the bot user:
  `goobster ALL=(root) NOPASSWD: /usr/bin/systemctl start goobster-update.service`.
- **Self-hosted GitHub Actions runner.** Works, but it keeps a runner process
  resident on the Pi and gives your workflows a shell on the box. The timer is
  cheaper.

## Operating notes

- **`npm ci` on a Pi 4B is the slow part.** Most deploys reuse the npm cache and
  finish quickly, but a lockfile change that rebuilds `better-sqlite3` or
  `@discordjs/opus` from source can take several minutes, and the bot is offline
  for that whole window. The unit allows 45 minutes and runs at `Nice=10` with
  idle I/O priority. If you are tight on RAM, make sure swap is enabled.
- **Downtime is expected.** This is a stop/start deploy, not a blue-green one:
  one bot process, one SQLite file, and voice connections do not survive a
  restart. Deploy when nobody is mid-adventure, or keep the timer window narrow.
- **Slash commands** are re-registered by `deploy-commands.js` on every start,
  but it hashes the command payload and skips the API call when nothing changed,
  so frequent deploys will not burn Discord rate limits.
- **Database migrations** apply through `db/schema.sql` on every DB open, and
  `initDb.js` runs during the install step. Schema changes must stay additive:
  a rollback puts old code on top of the new schema.
- **Logs** land in the journal (`journalctl -u goobster-update`) and in
  `logs/auto-update.log`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `fatal: detected dubious ownership` | The repo is owned by another user. Set `GOOBSTER_RUN_USER` to the owner, or `git config --global --add safe.directory /home/pi/goobster` for that user. |
| `node_modules` becomes root-owned | Something ran the installer as root directly. The updater always drops to `GOOBSTER_RUN_USER`; fix with `sudo chown -R pi:pi ~/goobster`. |
| Health check times out but the bot is fine | The health server binds port 3000; if you moved it, update `GOOBSTER_HEALTH_URL`, or clear it to only require an active unit. |
| Deploy loops on the same commit | The commit is genuinely broken: each run deploys, fails, and rolls back. Check `journalctl -u goobster -n 100`, then fix forward or revert on `main`. |
| Timer never fires | `systemctl list-timers goobster-update.timer` and `systemctl status goobster-update.timer`; the timer needs `enable --now`. |
| `another update is already running` | A previous deploy still holds `/var/lock/goobster-update.lock`. Normal while `npm ci` runs. |

## Docker instead

If you run the container (`docker-compose.yml`), the equivalent is a registry
image plus [Watchtower](https://containrrr.dev/watchtower/), or a cron job that
runs `git pull && docker compose up -d --build`. The script here targets the
systemd install because that is what `scripts/install-rpi.sh` sets up.

## Testing

`tests/autoUpdate.test.js` runs the real `scripts/auto-update.sh` against a
throwaway git remote with a stubbed `systemctl` and a fake health endpoint,
covering change detection, the deploy sequence, and both rollback paths
(unhealthy start and failed install). Run it with
`npx jest tests/autoUpdate.test.js`.
