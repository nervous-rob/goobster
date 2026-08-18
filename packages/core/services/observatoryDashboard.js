/**
 * Observatory dashboard renderer: turns one project's snapshot (registry
 * row, jobs, workspace listing, inlined media) into a single SELF-CONTAINED
 * HTML document - the shareable artifact generated as the final step of
 * every Observatory run.
 *
 * Design constraints, in order:
 *  - SAFE: every dynamic string is HTML-escaped, media is inlined as
 *    base64 data URLs from extension-checked files only, and a strict CSP
 *    meta tag pins what the page may do. The HTML is authored HERE by
 *    deterministic server code - never by the snippet - and the file is
 *    written OUTSIDE the (snippet-writable) workspace, so a run can never
 *    smuggle its own markup into a page we serve as trusted.
 *  - SELF-CONTAINED: no external assets, no portal URLs inside. The same
 *    file works served by the bot (owner view + share link), downloaded to
 *    disk, or forwarded to a friend.
 *  - LIVE FOR THE OWNER: a small inline script probes the authenticated
 *    API on load; when (and only when) the viewer is the signed-in owner
 *    on the bot's own origin, per-job Cancel/Resume, Render, and Refresh
 *    controls appear and call the normal Observatory routes. Share-link
 *    viewers and downloaded copies fail the probe and stay read-only.
 *
 * Pure module: buildDashboard(snapshot) -> html string. Gathering the
 * snapshot (DB reads, media file reads, size caps) is observatoryService's
 * job - this file only renders.
 */

/** Escape a string for HTML text/attribute contexts. */
function esc(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function kb(bytes) {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(1)} KB`;
}

const STATUS_META = {
    RUNNING: { icon: '🟢', color: '#3fb950' },
    COMPLETED: { icon: '✅', color: '#3fb950' },
    FAILED: { icon: '❌', color: '#f85149' },
    TIMED_OUT: { icon: '⏱️', color: '#d29922' },
    CANCELLED: { icon: '⏹️', color: '#8b949e' },
    INTERRUPTED: { icon: '💤', color: '#d29922' }
};

const CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: #0f1117; color: #e6e8ee; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 28px 20px 60px; }
header h1 { margin: 0 0 2px; font-size: 26px; }
header .sub { color: #8b949e; font-size: 13px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 6px; }
.chip { background: #1b2030; border: 1px solid #2b3245; border-radius: 999px; padding: 4px 12px; font-size: 13px; }
.chip b { color: #79b8ff; }
h2 { font-size: 17px; margin: 30px 0 10px; border-bottom: 1px solid #2b3245; padding-bottom: 6px; }
.card { background: #161b26; border: 1px solid #2b3245; border-radius: 12px; padding: 12px 14px; margin-bottom: 10px; }
.job-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: baseline; }
.status { font-weight: 600; font-size: 13px; }
.meta { color: #8b949e; font-size: 12.5px; }
.err { color: #f4a9a9; font-size: 13px; margin-top: 4px; }
details { margin-top: 6px; }
summary { cursor: pointer; color: #8b949e; font-size: 12.5px; }
pre { background: #0d1017; border: 1px solid #2b3245; border-radius: 8px; padding: 10px; overflow: auto; font-size: 12.5px; max-height: 320px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; }
.gallery figure { margin: 0; background: #161b26; border: 1px solid #2b3245; border-radius: 10px; padding: 6px; }
.gallery img { width: 100%; border-radius: 6px; display: block; }
.gallery figcaption { font-size: 11.5px; color: #8b949e; padding: 4px 2px 0; overflow-wrap: anywhere; }
video { width: 100%; max-height: 480px; border-radius: 12px; background: #000; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #222838; }
th { color: #8b949e; font-weight: 500; }
.quota { height: 6px; background: #1b2030; border-radius: 3px; overflow: hidden; margin-top: 8px; }
.quota i { display: block; height: 100%; background: #4c8dff; }
#controls { display: none; margin: 18px 0 0; }
#controls.on { display: block; }
#controls .row { display: flex; flex-wrap: wrap; gap: 8px; }
button { background: #22304d; color: #dbe6ff; border: 1px solid #3a4a6b; border-radius: 8px; padding: 7px 14px; font-size: 13.5px; cursor: pointer; }
button:hover { background: #2a3a5e; }
button.danger { background: #46232a; border-color: #6b3a44; color: #ffd9dd; }
#ctrl-msg { color: #8b949e; font-size: 12.5px; margin-top: 6px; min-height: 1em; }
footer { margin-top: 40px; color: #566; font-size: 12px; text-align: center; }
`;

/** The owner-only controls script (auth-probed; inert everywhere else). */
function controlsScript(slug) {
    // slug is validated as [a-z0-9-] upstream, safe in a JS string literal.
    return `
(function () {
  var base = '/api/app/observatory';
  var msg = function (text) { document.getElementById('ctrl-msg').textContent = text || ''; };
  function wire() {
    document.querySelectorAll('button[data-act]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var act = btn.getAttribute('data-act');
        var url = act === 'render'
          ? base + '/projects/${slug}/render'
          : base + '/jobs/' + btn.getAttribute('data-job') + '/' + act;
        fetch(url, { method: 'POST', credentials: 'same-origin' })
          .then(function (res) { return res.json().catch(function () { return {}; }).then(function (body) { return { ok: res.ok, body: body }; }); })
          .then(function (r) {
            if (!r.ok) { msg((r.body.error && r.body.error.message) || 'That did not work.'); btn.disabled = false; return; }
            msg('Done - refreshing…');
            setTimeout(function () { location.reload(); }, 900);
          })
          .catch(function () { msg('Network error.'); btn.disabled = false; });
      });
    });
    var refresh = document.getElementById('ctrl-refresh');
    if (refresh) refresh.addEventListener('click', function () { location.reload(); });
  }
  // Controls only for the signed-in owner on the bot's own origin; the
  // probe fails on share links, downloads, and anyone else's session.
  fetch(base + '/projects/${slug}', { credentials: 'same-origin' })
    .then(function (res) { if (!res.ok) throw new Error('no'); })
    .then(function () { document.getElementById('controls').classList.add('on'); wire(); })
    .catch(function () {});
})();`;
}

/**
 * Render the dashboard document.
 * @param {Object} snapshot
 * @param {{slug:string,name:string,createdAt:string,updatedAt:string}} snapshot.project
 * @param {number} snapshot.sizeMb - workspace size
 * @param {number} snapshot.quotaMb
 * @param {Array} snapshot.jobs - observatory_jobs rows (newest first)
 * @param {Array<{path:string,size:number,modifiedAt:string}>} snapshot.files
 * @param {number} snapshot.totalFiles
 * @param {Array<{name:string,dataUrl:string}>} snapshot.images - inlined gallery
 * @param {{name:string,dataUrl:string}|null} snapshot.video - inlined latest render
 * @param {number} snapshot.skippedMedia - media left out by the inline size caps
 * @param {string|null} snapshot.checkpoint - checkpoint.json content (capped)
 * @param {string} snapshot.generatedAt - UTC text
 * @returns {string} a complete HTML document
 */
function buildDashboard(snapshot) {
    const { project, jobs, files, images, video } = snapshot;
    const counts = { total: jobs.length, running: 0, completed: 0, failed: 0, resumes: 0 };
    for (const job of jobs) {
        if (job.status === 'RUNNING') counts.running++;
        else if (job.status === 'COMPLETED') counts.completed++;
        else if (job.status === 'FAILED' || job.status === 'TIMED_OUT') counts.failed++;
        counts.resumes += job.resumeCount || 0;
    }
    const quotaPct = Math.min(100, Math.round((snapshot.sizeMb / snapshot.quotaMb) * 100));

    const jobCards = jobs.map(job => {
        const meta = STATUS_META[job.status] || { icon: '·', color: '#8b949e' };
        const bits = [
            `${job.segments} segment(s)`,
            `${job.resumeCount} resume(s)`,
            job.exitCode !== null && job.exitCode !== undefined ? `exit ${job.exitCode}` : null,
            job.checkpointAt ? `checkpoint ${job.checkpointAt}` : null,
            job.finishedAt ? `finished ${job.finishedAt} UTC` : `heartbeat ${job.lastHeartbeatAt} UTC`
        ].filter(Boolean).join(' · ');
        const canCancel = job.status === 'RUNNING';
        const canResume = job.status === 'INTERRUPTED' || job.status === 'TIMED_OUT';
        return `<div class="card">
  <div class="job-head">
    <span class="status" style="color:${meta.color}">${meta.icon} ${esc(job.status)}</span>
    <strong>Job #${Number(job.id)}</strong>
    <span class="meta">${esc(job.language)} · ${esc(bits)}</span>
    ${canCancel ? `<button class="danger ctl" data-act="cancel" data-job="${Number(job.id)}" hidden>Cancel</button>` : ''}
    ${canResume ? `<button class="ctl" data-act="resume" data-job="${Number(job.id)}" hidden>▶ Resume</button>` : ''}
  </div>
  ${job.error ? `<div class="err">${esc(job.error)}</div>` : ''}
  ${job.stdoutTail?.trim() ? `<details><summary>stdout tail</summary><pre>${esc(job.stdoutTail)}</pre></details>` : ''}
  ${job.stderrTail?.trim() && job.status !== 'COMPLETED' ? `<details><summary>stderr tail</summary><pre>${esc(job.stderrTail)}</pre></details>` : ''}
</div>`;
    }).join('\n');

    const gallery = images.map(img =>
        `<figure><img src="${img.dataUrl}" alt="${esc(img.name)}" loading="lazy"><figcaption>${esc(img.name)}</figcaption></figure>`
    ).join('\n');

    const fileRows = files.map(file =>
        `<tr><td>${esc(file.path)}</td><td>${kb(file.size)}</td><td>${esc(file.modifiedAt)} UTC</td></tr>`
    ).join('\n');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'">
<meta name="robots" content="noindex">
<title>${esc(project.name)} · Goobster Observatory</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🔭 ${esc(project.name)}</h1>
    <div class="sub">Observatory project <code>${esc(project.slug)}</code> · created ${esc(project.createdAt)} UTC · dashboard generated ${esc(snapshot.generatedAt)} UTC</div>
  </header>

  <div class="chips">
    <span class="chip">Jobs <b>${counts.total}</b></span>
    <span class="chip">Completed <b>${counts.completed}</b></span>
    <span class="chip">Running <b>${counts.running}</b></span>
    <span class="chip">Failed <b>${counts.failed}</b></span>
    <span class="chip">Checkpoint resumes <b>${counts.resumes}</b></span>
    <span class="chip">Workspace <b>${snapshot.sizeMb} / ${snapshot.quotaMb} MB</b></span>
  </div>
  <div class="quota" role="img" aria-label="Disk quota ${quotaPct}% used"><i style="width:${quotaPct}%"></i></div>

  <div id="controls">
    <h2>Controls</h2>
    <div class="row">
      ${jobs.some(j => j.status === 'RUNNING' || j.status === 'INTERRUPTED' || j.status === 'TIMED_OUT')
        ? '<span class="meta">Per-job actions appear on the job cards below.</span>' : ''}
      <button data-act="render">🎬 Render frames to video</button>
      <button id="ctrl-refresh">↻ Refresh dashboard</button>
    </div>
    <div id="ctrl-msg"></div>
  </div>

  ${video ? `<h2>Latest render</h2>\n<video src="${video.dataUrl}" controls preload="metadata"></video>\n<div class="meta">${esc(video.name)}</div>` : ''}

  ${images.length > 0 ? `<h2>Gallery</h2>\n<div class="gallery">\n${gallery}\n</div>` : ''}
  ${snapshot.skippedMedia > 0 ? `<div class="meta" style="margin-top:6px">${snapshot.skippedMedia} media file(s) were too large to embed - browse them in the portal's Observatory pane.</div>` : ''}

  <h2>Jobs</h2>
  ${jobCards || '<div class="meta">No jobs yet.</div>'}

  ${snapshot.checkpoint ? `<h2>Latest checkpoint</h2>\n<pre>${esc(snapshot.checkpoint)}</pre>` : ''}

  <h2>Workspace files (${snapshot.totalFiles})</h2>
  ${fileRows
        ? `<table><thead><tr><th>Path</th><th>Size</th><th>Modified</th></tr></thead><tbody>\n${fileRows}\n</tbody></table>`
        : '<div class="meta">The workspace is empty.</div>'}
  ${snapshot.totalFiles > files.length ? `<div class="meta" style="margin-top:6px">Newest ${files.length} of ${snapshot.totalFiles} files shown.</div>` : ''}

  <footer>Generated by Goobster's Observatory · self-contained snapshot, safe to download or share</footer>
</div>
<script>${controlsScript(project.slug)}</script>
<script>
// Per-job control buttons live inside #controls' auth gate: reveal them
// only after the probe succeeds (the script above adds .on).
new MutationObserver(function () {
  if (document.getElementById('controls').classList.contains('on')) {
    document.querySelectorAll('button.ctl').forEach(function (b) { b.hidden = false; });
  }
}).observe(document.getElementById('controls'), { attributes: true, attributeFilter: ['class'] });
</script>
</body>
</html>`;
}

module.exports = { buildDashboard, esc };
