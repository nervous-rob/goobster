/**
 * Ready-made project apps (documentation/projects.md "App templates").
 *
 * Each template is one complete, self-contained HTML document built on the
 * Apps bridge (`window.goobster`), with its settings in an embedded
 * `<script id="goobster-app-config" type="application/json">` block and a
 * `goobster-project-access` declaration naming only what it uses. The
 * portal's "New app from template" and the observatory tool's
 * `save_app template=` both render through `renderTemplate`, then save the
 * result as an ordinary app asset (it is versioned and editable like any
 * other app afterwards).
 */

const TEMPLATE_IDS = ['data-table', 'run-console', 'chart'];

/** Shared look: follows the viewer's light/dark preference. */
const BASE_STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1f2328; --muted: #656d76; --line: #d0d7de;
  --raise: #f6f8fa; --accent: #0969da; --bad: #cf222e; --good: #1a7f37; }
@media (prefers-color-scheme: dark) { :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8d96a0; --line: #30363d;
  --raise: #161b22; --accent: #4493f8; --bad: #f85149; --good: #3fb950; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 12px 14px; background: var(--bg); color: var(--fg);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
h1 { font-size: 16px; margin: 0; }
.muted { color: var(--muted); font-size: 12px; }
.grow { flex: 1; }
button, input, select { font: inherit; color: inherit; }
button { background: var(--raise); border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); }
button:disabled { opacity: 0.5; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
input, select { background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
.bad { color: var(--bad); }
.good { color: var(--good); }
`;

const TEMPLATES = {
    'data-table': {
        id: 'data-table',
        name: 'Data table editor',
        description: 'Edit a JSON (array of objects) or CSV file in the workspace as a table: add, change and delete rows and columns, then save.',
        access: ['write'],
        params: [
            { key: 'path', label: 'File to edit', placeholder: 'data/table.json', required: true, hint: 'A .json file holding an array of objects, or a .csv file. Created on first save if missing.' }
        ],
        defaults: { path: 'data/table.json' },
        html: `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="goobster-project-access" content="write">
<title>__TITLE__</title>
<style>${BASE_STYLE}
.wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th, td { border-bottom: 1px solid var(--line); border-right: 1px solid var(--line); padding: 0; text-align: left; vertical-align: top; }
th { background: var(--raise); position: sticky; top: 0; font-weight: 600; white-space: nowrap; }
th span, td div { display: block; padding: 4px 8px; min-width: 60px; outline: none; }
td div:focus, th span:focus { background: color-mix(in srgb, var(--accent) 12%, transparent); }
td.tools, th.tools { width: 28px; text-align: center; border-right: 0; }
.x { border: 0; background: none; color: var(--muted); padding: 2px 6px; }
.x:hover { color: var(--bad); }
</style>
<script id="goobster-app-config" type="application/json">__CONFIG__</script>
</head><body>
<header>
  <h1 id="title"></h1><span id="file" class="muted"></span><span class="grow"></span>
  <button id="addRow">+ Row</button><button id="addCol">+ Column</button>
  <button id="reload">Reload</button><button id="save" class="primary" disabled>Save</button>
</header>
<p id="status" class="muted">Loading…</p>
<div class="wrap"><table id="grid"></table></div>
<script>
var cfg = JSON.parse(document.getElementById('goobster-app-config').textContent);
var isCsv = /\\.csv$/i.test(cfg.path);
var cols = [];
var rows = [];
var dirty = false;
document.getElementById('title').textContent = cfg.title;
document.getElementById('file').textContent = cfg.path;
function status(text, cls) { var el = document.getElementById('status'); el.textContent = text; el.className = cls || 'muted'; }
function setDirty(value) { dirty = value; document.getElementById('save').disabled = !value; }
function parseCsv(text) {
  var out = []; var row = []; var cell = ''; var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\\n' || c === '\\r') {
      if (c === '\\r' && text[i + 1] === '\\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); out.push(row); }
  return out.filter(function (r) { return r.length > 1 || r[0] !== ''; });
}
function csvCell(value) {
  var text = value == null ? '' : String(value);
  return /[",\\n\\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
function fromText(text) {
  if (isCsv) {
    var table = parseCsv(text);
    cols = table.length ? table[0] : [];
    rows = table.slice(1).map(function (r) { var o = {}; cols.forEach(function (c, i) { o[c] = r[i] == null ? '' : r[i]; }); return o; });
    return;
  }
  var data = text.trim() ? JSON.parse(text) : [];
  if (!Array.isArray(data)) throw new Error('The file is not a JSON array of objects.');
  rows = data.map(function (r) { return r && typeof r === 'object' ? r : { value: r }; });
  var seen = {};
  cols = [];
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; cols.push(k); } }); });
}
function toText() {
  if (isCsv) {
    return [cols.map(csvCell).join(',')].concat(rows.map(function (r) { return cols.map(function (c) { return csvCell(r[c]); }).join(','); })).join('\\n') + '\\n';
  }
  return JSON.stringify(rows.map(function (r) {
    var o = {};
    cols.forEach(function (c) {
      var v = r[c];
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) && /^-?\\d/.test(v.trim())) v = Number(v);
      else if (v === 'true' || v === 'false') v = v === 'true';
      o[c] = v === undefined ? '' : v;
    });
    return o;
  }), null, 2) + '\\n';
}
function render() {
  var grid = document.getElementById('grid');
  grid.textContent = '';
  var head = grid.insertRow();
  cols.forEach(function (c, ci) {
    var th = document.createElement('th');
    var name = document.createElement('span');
    name.contentEditable = 'true';
    name.textContent = c;
    name.title = 'Rename column';
    name.addEventListener('blur', function () {
      var next = name.textContent.trim();
      if (!next || next === c || cols.indexOf(next) >= 0) { name.textContent = c; return; }
      rows.forEach(function (r) { r[next] = r[c]; delete r[c]; });
      cols[ci] = next; setDirty(true); render();
    });
    var x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Delete column';
    x.onclick = function () { cols.splice(ci, 1); rows.forEach(function (r) { delete r[c]; }); setDirty(true); render(); };
    th.append(name, x);
    head.appendChild(th);
  });
  var tools = document.createElement('th'); tools.className = 'tools'; head.appendChild(tools);
  rows.forEach(function (r, ri) {
    var tr = grid.insertRow();
    cols.forEach(function (c) {
      var td = tr.insertCell();
      var div = document.createElement('div');
      div.contentEditable = 'true';
      div.textContent = r[c] == null ? '' : (typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c]));
      div.addEventListener('input', function () { r[c] = div.textContent; setDirty(true); });
      td.appendChild(div);
    });
    var cell = tr.insertCell(); cell.className = 'tools';
    var x = document.createElement('button');
    x.className = 'x'; x.textContent = '×'; x.title = 'Delete row';
    x.onclick = function () { rows.splice(ri, 1); setDirty(true); render(); };
    cell.appendChild(x);
  });
  status(rows.length + ' row(s) · ' + cols.length + ' column(s)' + (dirty ? ' · unsaved changes' : ''));
}
function load() {
  status('Loading…');
  return goobster.read(cfg.path, 'text').then(function (text) { fromText(text); setDirty(false); render(); })
    .catch(function (err) {
      if (err.code === 'NOT_FOUND') { cols = ['name', 'value']; rows = []; setDirty(false); render(); status('New file: add rows, then Save to create ' + cfg.path + '.'); return; }
      status('Could not load: ' + err.message, 'bad');
    });
}
document.getElementById('addRow').onclick = function () { var r = {}; cols.forEach(function (c) { r[c] = ''; }); rows.push(r); setDirty(true); render(); };
document.getElementById('addCol').onclick = function () {
  var name = prompt('Column name');
  if (!name || cols.indexOf(name) >= 0) return;
  cols.push(name); rows.forEach(function (r) { r[name] = ''; }); setDirty(true); render();
};
document.getElementById('reload').onclick = function () { if (!dirty || confirm('Discard unsaved changes?')) load(); };
document.getElementById('save').onclick = function () {
  status('Saving…');
  goobster.write(cfg.path, toText(), { encoding: 'utf8' })
    .then(function () { setDirty(false); render(); status('Saved ' + cfg.path + ' at ' + new Date().toLocaleTimeString() + '.', 'good'); })
    .catch(function (err) { status(err.code === 'ACCESS_DENIED' ? 'Saving needs your permission: Reset approvals above and try again.' : 'Could not save: ' + err.message, 'bad'); });
};
load();
</script>
</body></html>
`
    },
    'run-console': {
        id: 'run-console',
        name: 'Run console',
        description: 'Run a workspace program (.py, .js or .sh) with arguments and watch its output live; keeps this session\'s runs.',
        access: ['run'],
        params: [
            { key: 'path', label: 'Program to run', placeholder: 'sim/run.py', required: true, hint: 'A .py, .js, .cjs, .mjs or .sh file in the workspace.' },
            { key: 'args', label: 'Default arguments', placeholder: '--days 30', required: false, hint: 'Shell-style; quotes group words.' }
        ],
        defaults: { path: 'main.py', args: '' },
        html: `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="goobster-project-access" content="run">
<title>__TITLE__</title>
<style>${BASE_STYLE}
.bar { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
#args { flex: 1; min-width: 160px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
pre { margin: 0; padding: 10px; background: var(--raise); border: 1px solid var(--line); border-radius: 8px;
  min-height: 160px; max-height: 60vh; overflow: auto; white-space: pre-wrap; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.err { color: var(--bad); }
.badge { font-size: 12px; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); }
ol { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
ol button { border: 0; background: none; padding: 0; color: var(--accent); }
</style>
<script id="goobster-app-config" type="application/json">__CONFIG__</script>
</head><body>
<header><h1 id="title"></h1><code id="file" class="muted"></code><span class="grow"></span><span id="state" class="badge">idle</span></header>
<div class="bar"><input id="args" aria-label="Arguments" placeholder="arguments"><button id="run" class="primary" type="button">▶ Run</button><button id="stop" type="button" disabled>Stop watching</button></div>
<pre id="out" aria-live="polite"></pre>
<ol id="history"></ol>
<script>
var cfg = JSON.parse(document.getElementById('goobster-app-config').textContent);
var watching = null;
document.getElementById('title').textContent = cfg.title;
document.getElementById('file').textContent = cfg.path;
document.getElementById('args').value = cfg.args || '';
function splitArgs(text) {
  var out = []; var cur = ''; var quote = null; var has = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i];
    if (quote) { if (c === quote) quote = null; else cur += c; }
    else if (c === '"' || c === "'") { quote = c; has = true; }
    else if (/\\s/.test(c)) { if (cur || has) { out.push(cur); cur = ''; has = false; } }
    else { cur += c; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}
function state(text, cls) { var el = document.getElementById('state'); el.textContent = text; el.className = 'badge ' + (cls || ''); }
function show(update) {
  var out = document.getElementById('out');
  out.textContent = '';
  out.appendChild(document.createTextNode(update.stdout || ''));
  if (update.stderr) { var err = document.createElement('span'); err.className = 'err'; err.textContent = update.stderr; out.appendChild(err); }
  out.scrollTop = out.scrollHeight;
}
function remember(jobId, args, status) {
  var li = document.createElement('li');
  var link = document.createElement('button');
  link.type = 'button';
  link.textContent = '#' + jobId + ' ' + (args.join(' ') || '(no arguments)') + ' · ' + status;
  link.onclick = function () { document.getElementById('args').value = args.join(' '); };
  li.appendChild(link);
  var list = document.getElementById('history');
  list.insertBefore(li, list.firstChild);
}
document.getElementById('stop').onclick = function () { if (watching) watching.stop(); };
// No form element: the app frame is sandboxed without allow-forms, so submitting would be blocked.
document.getElementById('args').addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !document.getElementById('run').disabled) { event.preventDefault(); start(); }
});
document.getElementById('run').onclick = function () { start(); };
function start() {
  var args = splitArgs(document.getElementById('args').value);
  document.getElementById('run').disabled = true;
  document.getElementById('out').textContent = '';
  state('starting…');
  goobster.run(cfg.path, { args: args, background: true }).then(function (started) {
    state('running #' + started.jobId);
    document.getElementById('stop').disabled = false;
    watching = goobster.watch(started.jobId, function (update) {
      show(update);
      state(update.running ? 'running #' + started.jobId : String(update.status || 'done').toLowerCase(), update.running ? '' : (update.status === 'COMPLETED' ? 'good' : 'bad'));
    });
    return watching.done.then(function (last) { remember(started.jobId, args, last ? String(last.status || '').toLowerCase() : 'stopped watching'); });
  }).catch(function (err) {
    state('failed', 'bad');
    document.getElementById('out').textContent = err.code === 'ACCESS_DENIED' ? 'Running needs your permission: Reset approvals above and try again.' : (err.message || String(err));
  }).then(function () {
    document.getElementById('run').disabled = false;
    document.getElementById('stop').disabled = true;
    watching = null;
  });
}
</script>
</body></html>
`
    },
    chart: {
        id: 'chart',
        name: 'Chart',
        description: 'Plot a JSON (array of objects) or CSV file from the workspace as a line chart; pick the x column and the series, and refresh as runs update it.',
        access: [],
        params: [
            { key: 'path', label: 'Data file', placeholder: 'runs/metrics.csv', required: true, hint: 'A .json array of objects or a .csv file with a header row.' }
        ],
        defaults: { path: 'data/metrics.csv' },
        html: `<!doctype html>
<html><head><meta charset="utf-8">
<title>__TITLE__</title>
<style>${BASE_STYLE}
.controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; font-size: 13px; }
.series label { margin-right: 8px; white-space: nowrap; }
svg { width: 100%; height: auto; display: block; }
.axis { stroke: var(--line); }
.tick { fill: var(--muted); font-size: 11px; }
.grid { stroke: var(--line); stroke-opacity: 0.5; }
.legend { font-size: 12px; display: flex; gap: 12px; flex-wrap: wrap; }
.swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
</style>
<script id="goobster-app-config" type="application/json">__CONFIG__</script>
</head><body>
<header><h1 id="title"></h1><span id="file" class="muted"></span><span class="grow"></span>
<label class="muted"><input type="checkbox" id="auto"> refresh every 10 s</label><button id="reload">Reload</button></header>
<div class="controls"><label>x <select id="x"></select></label><span class="series" id="series"></span></div>
<svg id="chart" viewBox="0 0 800 360" role="img" aria-label="Chart"></svg>
<div class="legend" id="legend"></div>
<p id="status" class="muted"></p>
<script>
var cfg = JSON.parse(document.getElementById('goobster-app-config').textContent);
var COLORS = ['#4493f8', '#f0883e', '#3fb950', '#db61a2', '#a371f7', '#d29922', '#56d4dd', '#f85149'];
var rows = [], cols = [], xCol = null, chosen = {}, timer = null;
document.getElementById('title').textContent = cfg.title;
document.getElementById('file').textContent = cfg.path;
function status(text, cls) { var el = document.getElementById('status'); el.textContent = text; el.className = cls || 'muted'; }
function parseCsv(text) {
  var lines = text.split(/\\r?\\n/).filter(function (l) { return l.trim() !== ''; });
  var split = function (line) {
    var out = []; var cell = ''; var quoted = false;
    for (var i = 0; i < line.length; i++) {
      var c = line[i];
      if (quoted) { if (c === '"' && line[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') quoted = false; else cell += c; }
      else if (c === '"') quoted = true; else if (c === ',') { out.push(cell); cell = ''; } else cell += c;
    }
    out.push(cell); return out;
  };
  var head = lines.length ? split(lines[0]) : [];
  return lines.slice(1).map(function (l) { var r = split(l); var o = {}; head.forEach(function (h, i) { o[h] = r[i]; }); return o; });
}
function num(v) { if (typeof v === 'number') return v; var n = Number(v); return v === '' || v == null || isNaN(n) ? null : n; }
function setup() {
  var seen = {}; cols = [];
  rows.forEach(function (r) { Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; cols.push(k); } }); });
  var numeric = cols.filter(function (c) { return rows.some(function (r) { return num(r[c]) != null; }); });
  if (!xCol || cols.indexOf(xCol) < 0) xCol = cols[0] || null;
  var xs = document.getElementById('x'); xs.textContent = '';
  cols.forEach(function (c) { var o = document.createElement('option'); o.value = c; o.textContent = c; o.selected = c === xCol; xs.appendChild(o); });
  var box = document.getElementById('series'); box.textContent = '';
  var any = numeric.some(function (c) { return chosen[c]; });
  numeric.forEach(function (c, i) {
    if (c === xCol) return;
    if (!any && i < 4) chosen[c] = true;
    var label = document.createElement('label');
    var input = document.createElement('input'); input.type = 'checkbox'; input.checked = Boolean(chosen[c]);
    input.onchange = function () { chosen[c] = input.checked; draw(); };
    label.append(input, ' ' + c); box.appendChild(label);
  });
}
function draw() {
  var svg = document.getElementById('chart'); svg.textContent = '';
  var legend = document.getElementById('legend'); legend.textContent = '';
  var series = cols.filter(function (c) { return chosen[c] && c !== xCol; });
  if (!rows.length || !xCol || !series.length) { status(rows.length ? 'Pick a numeric series to plot.' : 'No rows yet.'); return; }
  var numericX = rows.every(function (r) { return num(r[xCol]) != null; });
  var xv = rows.map(function (r, i) { return numericX ? num(r[xCol]) : i; });
  var ys = [];
  series.forEach(function (c) { rows.forEach(function (r) { var v = num(r[c]); if (v != null) ys.push(v); }); });
  var x0 = Math.min.apply(null, xv), x1 = Math.max.apply(null, xv);
  var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
  if (x0 === x1) x1 = x0 + 1; if (y0 === y1) { y0 -= 1; y1 += 1; }
  var L = 56, R = 16, T = 14, B = 34, W = 800, H = 360;
  var sx = function (v) { return L + (v - x0) / (x1 - x0) * (W - L - R); };
  var sy = function (v) { return H - B - (v - y0) / (y1 - y0) * (H - T - B); };
  var ns = 'http://www.w3.org/2000/svg';
  var el = function (name, attrs, text) { var e = document.createElementNS(ns, name); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
  for (var t = 0; t <= 4; t++) {
    var yv = y0 + (y1 - y0) * t / 4;
    el('line', { x1: L, x2: W - R, y1: sy(yv), y2: sy(yv), 'class': 'grid' });
    el('text', { x: L - 6, y: sy(yv) + 4, 'text-anchor': 'end', 'class': 'tick' }, Number(yv.toPrecision(4)).toString());
    var xvT = x0 + (x1 - x0) * t / 4;
    var label = numericX ? Number(xvT.toPrecision(4)).toString() : String(rows[Math.round(xvT)] ? rows[Math.round(xvT)][xCol] : '');
    el('text', { x: sx(xvT), y: H - B + 16, 'text-anchor': 'middle', 'class': 'tick' }, label);
  }
  el('line', { x1: L, x2: W - R, y1: H - B, y2: H - B, 'class': 'axis' });
  el('line', { x1: L, x2: L, y1: T, y2: H - B, 'class': 'axis' });
  series.forEach(function (c, i) {
    var color = COLORS[i % COLORS.length];
    var pts = [];
    rows.forEach(function (r, ri) { var v = num(r[c]); if (v != null) pts.push(sx(xv[ri]).toFixed(1) + ',' + sy(v).toFixed(1)); });
    el('polyline', { points: pts.join(' '), fill: 'none', stroke: color, 'stroke-width': 2 });
    var item = document.createElement('span');
    var sw = document.createElement('span'); sw.className = 'swatch'; sw.style.background = color;
    item.append(sw, c); legend.appendChild(item);
  });
  status(rows.length + ' row(s) · updated ' + new Date().toLocaleTimeString());
}
function load() {
  return goobster.read(cfg.path, 'text').then(function (text) {
    if (/\\.csv$/i.test(cfg.path)) rows = parseCsv(text);
    else { var data = JSON.parse(text); rows = Array.isArray(data) ? data : []; }
    setup(); draw();
  }).catch(function (err) { status(err.code === 'NOT_FOUND' ? cfg.path + ' does not exist yet.' : 'Could not load: ' + err.message, 'bad'); });
}
document.getElementById('x').onchange = function (e) { xCol = e.target.value; setup(); draw(); };
document.getElementById('reload').onclick = load;
document.getElementById('auto').onchange = function (e) { clearInterval(timer); timer = e.target.checked ? setInterval(load, 10000) : null; };
load();
</script>
</body></html>
`
    }
};

class AppTemplateError extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'AppTemplateError';
        this.status = status;
        this.code = code;
    }
}

/** The catalog, without the HTML (portal picker, tool description). */
function listTemplates() {
    return TEMPLATE_IDS.map((id) => {
        const { name, description, access, params, defaults } = TEMPLATES[id];
        return { id, name, description, access: [...access], params: params.map((p) => ({ ...p })), defaults: { ...defaults } };
    });
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * The app's HTML for one template: its title and settings, validated.
 * @param {string} id template id
 * @param {{ title?: string, path?: string, args?: string }} params
 * @returns {{ id: string, name: string, source: string, config: object }}
 */
function renderTemplate(id, params = {}) {
    const template = TEMPLATES[String(id || '').trim().toLowerCase()];
    if (!template) {
        throw new AppTemplateError(400, 'NO_SUCH_TEMPLATE',
            `Unknown app template "${id}". Templates: ${TEMPLATE_IDS.join(', ')}.`);
    }
    const title = String(params.title || template.name).trim().slice(0, 120) || template.name;
    const config = { title };
    for (const param of template.params) {
        const raw = params[param.key] ?? template.defaults[param.key] ?? '';
        const value = String(raw).trim().slice(0, 1000);
        if (param.required && !value) {
            throw new AppTemplateError(400, 'BAD_TEMPLATE_PARAM', `${param.label} is required.`);
        }
        if (param.key === 'path') {
            const clean = value.replace(/\\/g, '/').replace(/^\/+/, '');
            if (!clean || clean.split('/').some((part) => part === '..' || part === '')) {
                throw new AppTemplateError(400, 'BAD_PATH', 'The file must be a workspace-relative path.');
            }
            config.path = clean;
        } else {
            config[param.key] = value;
        }
    }
    // `<` never appears raw inside the config block, so no value can close it.
    const configJson = JSON.stringify(config).replace(/</g, '\\u003c');
    const source = template.html
        .replace('__TITLE__', () => escapeHtml(title))
        .replace('__CONFIG__', () => configJson);
    return { id: template.id, name: title, source, config };
}

module.exports = { listTemplates, renderTemplate, AppTemplateError, TEMPLATE_IDS };
