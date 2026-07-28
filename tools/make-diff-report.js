#!/usr/bin/env node
// make-diff-report.js — generate a self-contained HTML diff report (Monaco
// side-by-side, wordWrap:on + wrappingIndent:'indent'
// style) for a git ref range, with an optional markdown summary on top.
//
// Usage:
//   node tools/make-diff-report.js --repo <path> --base <ref> --head <ref> \
//        --title "..." [--summary <md-file>] --out <html-path>
//
// Output HTML is fully static (Monaco loaded from cdnjs); drop it in
// output/reports/<name>.html and the watch-page shows a "diff report" button
// on the output card with the same basename (see web/server.js /report).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function arg(name, req) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1 || !process.argv[i + 1]) {
    if (req) { console.error('missing --' + name); process.exit(1); }
    return null;
  }
  return process.argv[i + 1];
}

const REPO = arg('repo', true), BASE = arg('base', true), HEAD = arg('head', true);
const TITLE = arg('title', true), OUT = arg('out', true), SUMMARY = arg('summary');

const git = (...a) => execFileSync('git', a, { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString();
const show = (ref, file) => {
  try { return execFileSync('git', ['show', ref + ':' + file], { cwd: REPO, maxBuffer: 64 * 1024 * 1024 }).toString(); }
  catch (_) { return ''; } // added or deleted file
};

const LANGS = { py: 'python', js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
  json: 'json', md: 'markdown', html: 'html', css: 'css', sh: 'shell', yml: 'yaml', yaml: 'yaml',
  sql: 'sql', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', toml: 'ini', ini: 'ini', txt: 'plaintext' };
const langOf = (f) => LANGS[f.split('.').pop().toLowerCase()] || 'plaintext';

// ---- collect files -------------------------------------------------------
const numstat = git('diff', '--numstat', BASE + '..' + HEAD).trim();
const files = numstat ? numstat.split('\n').map((l) => {
  const [add, del, file] = l.split('\t');
  return {
    path: file, add: +add || 0, del: +del || 0, lang: langOf(file),
    before: show(BASE, file), after: show(HEAD, file),
  };
}) : [];
if (!files.length) { console.error('no diff between ' + BASE + ' and ' + HEAD); process.exit(1); }

const headLine = git('log', '-1', '--format=%h %s', HEAD).trim();
const baseLine = git('log', '-1', '--format=%h %s', BASE).trim();

// ---- minimal markdown -> html for the summary block ----------------------
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function mdToHtml(md) {
  const out = [];
  const lines = md.split('\n');
  let inCode = false, code = [];
  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) { out.push('<pre class="code">' + esc(code.join('\n')) + '</pre>'); code = []; }
      inCode = !inCode; continue;
    }
    if (inCode) { code.push(line); continue; }
    let h = esc(line)
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s()<>]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(?<!["=])\bhttps?:\/\/[^\s<>&)]+/g, (u) => '<a href="' + u + '" target="_blank" rel="noopener">' + u + '</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
    if (/^### /.test(h)) h = '<h4>' + h.slice(4) + '</h4>';
    else if (/^## /.test(h)) h = '<h3>' + h.slice(3) + '</h3>';
    else if (/^# /.test(h)) h = '<h2>' + h.slice(2) + '</h2>';
    else if (h.trim() === '') h = '<div class="gap"></div>';
    else h = '<div>' + h + '</div>';
    out.push(h);
  }
  if (code.length) out.push('<pre class="code">' + esc(code.join('\n')) + '</pre>');
  return out.join('\n');
}
const summaryHtml = SUMMARY ? mdToHtml(fs.readFileSync(SUMMARY, 'utf8')) : '';

// ---- assemble page -------------------------------------------------------
const payload = JSON.stringify({ files }).replace(/<\/script/gi, '<\\/script');
const totAdd = files.reduce((s, f) => s + f.add, 0), totDel = files.reduce((s, f) => s + f.del, 0);

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(TITLE)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#1e1e1e; color:#ccc; font:14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         height:100vh; display:flex; flex-direction:column; }
  .header { background:#2d2d30; padding:8px 16px; box-shadow:0 2px 8px rgba(0,0,0,.3); flex:none; }
  .header h1 { margin:0; font-size:17px; font-weight:500; color:#e8e6e0; }
  .header .meta { font-size:12px; color:#8a8a8a; margin-top:2px; font-family:ui-monospace,monospace; }
  .stat { color:#4ec9b0; } .statd { color:#d9756b; }
  #summary { flex:none; max-height:38vh; overflow-y:auto; padding:10px 18px; background:#181818;
             border-bottom:1px solid #333; font-size:13.5px; }
  #summary h2,#summary h3,#summary h4 { color:#c9b458; margin:.7em 0 .3em; font-size:1.05em; }
  #summary code { background:#2a2a2a; padding:0 4px; border-radius:3px; font:12px ui-monospace,monospace; }
  #summary pre.code { background:#111; border:1px solid #333; border-radius:6px; padding:8px;
                      font:12px/1.5 ui-monospace,monospace; overflow-x:auto; white-space:pre-wrap; }
  #summary a { color:#6fb3d2; } #summary .gap { height:.5em; }
  #summary.collapsed { max-height:0; padding:0 18px; overflow:hidden; border-bottom:none; }
  .bar { flex:none; display:flex; align-items:center; gap:6px; background:#252526; padding:5px 10px;
         overflow-x:auto; border-bottom:1px solid #333; }
  .bar button.file { background:#2d2d30; color:#bbb; border:1px solid #3c3c3c; border-radius:5px;
         padding:3px 10px; font:12px ui-monospace,monospace; cursor:pointer; white-space:nowrap; }
  .bar button.file.active { background:#0e639c; color:#fff; border-color:#1177bb; }
  .bar .right { margin-left:auto; display:flex; gap:6px; }
  .bar .right button { background:#3a3d41; color:#ccc; border:0; border-radius:5px; padding:3px 10px;
                       font:12px inherit; cursor:pointer; }
  #container { flex:1; min-height:0; }
</style>
</head><body>
<div class="header">
  <h1>${esc(TITLE)}</h1>
  <div class="meta">${esc(baseLine)} → ${esc(headLine)} · ${files.length} file${files.length === 1 ? '' : 's'} · <span class="stat">+${totAdd}</span> <span class="statd">−${totDel}</span></div>
</div>
${summaryHtml ? '<div id="summary">' + summaryHtml + '</div>' : ''}
<div class="bar">
  <span id="tabs"></span>
  <span class="right">
    ${summaryHtml ? '<button onclick="toggleSummary()" id="sumbtn">hide summary</button>' : ''}
    <button onclick="toggleView()" id="viewbtn">inline view</button>
    <button onclick="toggleWrap()" id="wrapbtn">wrap: on</button>
  </span>
</div>
<div id="container"></div>
<script id="data" type="application/json">${payload}</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs/loader.js"></script>
<script>
  const DATA = JSON.parse(document.getElementById('data').textContent);
  let editor, cur = 0, sideBySide = true, wrap = true;
  const models = [];
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    editor = monaco.editor.createDiffEditor(document.getElementById('container'), {
      wordWrap: 'on', wrappingIndent: 'indent',       // the diff2 trick: no h-scroll, indent-aware wrap
      renderSideBySide: true, ignoreTrimWhitespace: false, renderIndicators: true,
      readOnly: true, originalEditable: false, automaticLayout: true,
      scrollBeyondLastLine: false, minimap: { enabled: true }, theme: 'vs-dark',
      fontSize: 12.5, diffWordWrap: 'on',
    });
    DATA.files.forEach((f) => models.push({
      original: monaco.editor.createModel(f.before, f.lang),
      modified: monaco.editor.createModel(f.after, f.lang),
    }));
    renderTabs(); select(0);
  });
  function renderTabs() {
    document.getElementById('tabs').innerHTML = DATA.files.map((f, i) =>
      '<button class="file' + (i === cur ? ' active' : '') + '" onclick="select(' + i + ')">' +
      f.path.split('/').pop() + ' <span class="stat">+' + f.add + '</span> <span class="statd">−' + f.del + '</span></button>'
    ).join('');
  }
  window.select = (i) => { cur = i; editor.setModel(models[i]); renderTabs(); document.title = DATA.files[i].path; };
  window.toggleView = () => {
    sideBySide = !sideBySide;
    editor.updateOptions({ renderSideBySide: sideBySide });
    document.getElementById('viewbtn').textContent = sideBySide ? 'inline view' : 'side-by-side';
  };
  window.toggleWrap = () => {
    wrap = !wrap;
    editor.updateOptions({ wordWrap: wrap ? 'on' : 'off', diffWordWrap: wrap ? 'on' : 'off' });
    document.getElementById('wrapbtn').textContent = 'wrap: ' + (wrap ? 'on' : 'off');
  };
  window.toggleSummary = () => {
    const s = document.getElementById('summary');
    s.classList.toggle('collapsed');
    document.getElementById('sumbtn').textContent = s.classList.contains('collapsed') ? 'show summary' : 'hide summary';
  };
</script>
</body></html>
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log('wrote ' + OUT + ' (' + files.length + ' files, +' + totAdd + ' -' + totDel + ')');
