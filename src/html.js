'use strict';
// Webview HTML for the viewer and the Pro tool panels. No vscode import, so tests can check the CSP: no remote origin,
// no connect-src, no worker or blob source, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'msgpackViewer';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

function head(p, n) {
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return { footer, html: `<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>` };
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, showPro, head?(nonce) } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body data-pro="${p.showPro === false ? '0' : '1'}">
<div id="toolbar" role="toolbar" aria-label="MessagePack, CBOR and BSON viewer">
  <span id="fmt" class="chip" title="Format, values and size"></span>
  <label class="muted" for="readAs">Read as</label>
  <select id="readAs" title="Read the bytes as another format"></select>
  <span class="grp" role="group" aria-label="View"><button class="tb tab sel" id="modeTree" title="Tree with types, sizes and byte offsets">Tree</button><button class="tb tab" id="modeJson" title="The selected value as JSON">JSON</button></span>
  <input id="search" type="search" spellcheck="false" placeholder="Search keys and values" aria-label="Search keys and values">
  <span id="count" class="muted"></span>
  <button class="tb" id="collapse" title="Collapse the tree">Collapse</button>
</div>
<div id="msg" role="alert" hidden></div>
<div id="app">
  <main id="main">
    <section id="results" hidden aria-label="Search results"></section>
    <div id="treeHead" class="trow head" aria-hidden="true"><span class="k">Key</span><span class="ty">Type</span><span class="off">Offset</span><span class="sz">Bytes</span><span class="pv">Value</span></div>
    <div id="tree" role="tree"></div>
    <section id="json" hidden aria-label="JSON"><div class="row"><button class="tb" id="copyAllJson">Copy JSON</button> <span id="jsonNote" class="muted"></span></div><pre id="jsonText"></pre></section>
  </main>
  <aside id="side" aria-label="Value details">
    <section id="details"><p class="muted">Click a value in the tree to see its type, its byte offset and its bytes.</p></section>
  </aside>
</div>
<div id="status"><span id="statusText"></span></div>
<div id="footer"></div>
<template id="zovo-footer">${h.footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const h = head(p, n);
  return `<!DOCTYPE html>
<html lang="en">
<head>
${h.html}
</head>
<body class="panel">
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app" class="panelApp">
  <div id="report"><p class="muted">Working...</p></div>
</div>
<div id="footer">${h.footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
