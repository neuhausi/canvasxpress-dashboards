/**
 * The dashboard grid stylesheet, exported as a string and as an injector so the
 * renderer stays fully self-contained (no external CSS file to load).
 *
 * @module styles
 */

/** @type {string} The dashboard CSS. */
export var dashboardCss = [
  '.cxd-dashboard { box-sizing: border-box; width: 100%; }',
  '.cxd-dashboard *, .cxd-dashboard *::before, .cxd-dashboard *::after { box-sizing: border-box; }',
  '.cxd-grid { width: 100%; }',
  '.cxd-panel { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0;',
  '  border: 1px solid var(--cxd-border, #e2e5ea); border-radius: 8px; overflow: hidden;',
  '  background: var(--cxd-panel-bg, #ffffff); }',
  '.cxd-panel-title { flex: 0 0 auto; padding: 6px 10px; font: 600 13px/1.3 system-ui, sans-serif;',
  '  color: var(--cxd-title, #2a2f36); border-bottom: 1px solid var(--cxd-border, #e2e5ea);',
  '  background: var(--cxd-title-bg, #f7f8fa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.cxd-panel-body { position: relative; flex: 1 1 auto; min-height: 0; }',
  '.cxd-canvas { display: block; width: 100%; height: 100%; }',
  '.cxd-panel-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;',
  '  font: 500 13px system-ui, sans-serif; color: var(--cxd-muted, #8a9099);',
  '  background: var(--cxd-panel-bg, #ffffff); }',
  '.cxd-panel-overlay.cxd-error { color: var(--cxd-error, #c0392b); padding: 8px; text-align: center; }',
  '.cxd-theme-dark { --cxd-border: #2c313a; --cxd-panel-bg: #16181d; --cxd-title: #e6e8ec;',
  '  --cxd-title-bg: #1d2027; --cxd-muted: #7d848f; }',
  '@media (prefers-color-scheme: dark) {',
  '  .cxd-theme-auto { --cxd-border: #2c313a; --cxd-panel-bg: #16181d; --cxd-title: #e6e8ec;',
  '    --cxd-title-bg: #1d2027; --cxd-muted: #7d848f; } }',
  /* ---- builder (Phase 4) ---- */
  '.cxb { display: flex; flex-direction: column; gap: 10px; font-family: system-ui, sans-serif; }',
  '.cxb-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
  '.cxb-toolbar input[type=text] { padding: 5px 8px; border: 1px solid var(--cxd-border,#e2e5ea);',
  '  border-radius: 6px; font: inherit; }',
  '.cxb-btn { padding: 5px 11px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px;',
  '  background: var(--cxd-title-bg,#f7f8fa); color: inherit; font: 500 13px system-ui; cursor: pointer; }',
  '.cxb-btn:hover { background: #eceef1; }',
  '.cxb-btn-primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }',
  '.cxb-btn-primary:hover { background: #295fd0; }',
  '.cxb-body { display: flex; gap: 12px; align-items: flex-start; }',
  '.cxb-stage { flex: 1 1 auto; min-width: 0; }',
  '.cxb-editor { flex: 0 0 260px; border: 1px solid var(--cxd-border,#e2e5ea); border-radius: 8px;',
  '  padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
  '.cxb-editor label { display: block; font: 600 11px system-ui; text-transform: uppercase;',
  '  letter-spacing: .03em; color: var(--cxd-muted,#8a9099); margin-bottom: 3px; }',
  '.cxb-editor input, .cxb-editor select, .cxb-editor textarea { width: 100%; box-sizing: border-box;',
  '  padding: 5px 7px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px; font: inherit; }',
  '.cxb-editor textarea { font-family: ui-monospace, Menlo, monospace; font-size: 12px; min-height: 90px; }',
  '.cxb-cell { position: relative; }',
  '.cxb-cell.cxb-selected { outline: 2px solid #2f6feb; outline-offset: -1px; }',
  '.cxb-cell .cxd-panel-title { cursor: grab; user-select: none; }',
  '.cxb-cell .cxb-body-fill { position: absolute; inset: 0; top: 28px; display: flex; align-items: center;',
  '  justify-content: center; color: var(--cxd-muted,#8a9099); font: 500 12px system-ui; pointer-events: none; }',
  '.cxb-resize { position: absolute; right: 0; bottom: 0; width: 16px; height: 16px; cursor: nwse-resize;',
  '  background: linear-gradient(135deg, transparent 50%, #2f6feb 50%); border-bottom-right-radius: 8px; }',
  '.cxb-del { position: absolute; right: 4px; top: 3px; width: 18px; height: 18px; line-height: 16px;',
  '  text-align: center; border-radius: 50%; background: rgba(0,0,0,.06); cursor: pointer; font-size: 13px; }',
  '.cxb-del:hover { background: #e5534b; color: #fff; }',
  '.cxb-msg { font-size: 12px; color: var(--cxd-muted,#8a9099); min-height: 16px; }'
].join('\n');

/**
 * Inject the dashboard stylesheet once into the document head.
 * @param {Document} [doc] - Target document; defaults to the global document.
 * @returns {void}
 */
export function injectStyles(doc) {
  doc = doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) return;
  if (doc.getElementById('cxd-styles')) return;
  var style = doc.createElement('style');
  style.id = 'cxd-styles';
  style.textContent = dashboardCss;
  doc.head.appendChild(style);
}
