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
  /* when panels reserve a canvas margin, centre the (smaller) graph in the cell */
  '.cxd-inset .cxd-panel-body { display: flex; align-items: center; justify-content: center; }',
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
  /* toolbar (host may be an app-shell element) */
  '.cxb-topbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; width: 100%; }',
  '.cxb-tgroup { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '.cxb-spacer { flex: 1 1 auto; }',
  '.cxb-tlabel { font: 600 11px system-ui; text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted,#8a9099); }',
  '.cxb-title-input { padding: 5px 8px; border: 1px solid var(--cxd-border,#e2e5ea);',
  '  border-radius: 6px; font: 600 14px system-ui; min-width: 150px; }',
  '.cxb-tinput { padding: 5px 8px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px;',
  '  font: inherit; width: 130px; }',
  '.cxb-props { padding-left: 8px; border-left: 1px solid var(--cxd-border,#e2e5ea); }',
  '.cxb-props:empty { border-left: none; padding-left: 0; }',
  '.cxb-props select { padding: 5px 7px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px; font: inherit; }',
  '.cxb-btn { padding: 5px 11px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px;',
  '  background: var(--cxd-title-bg,#f7f8fa); color: inherit; font: 500 13px system-ui; cursor: pointer; }',
  '.cxb-btn:hover { background: #eceef1; }',
  '.cxb-btn-primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }',
  '.cxb-btn-primary:hover { background: #295fd0; }',
  '.cxb-stage { width: 100%; min-width: 0; }',
  /* live editable cells */
  '.cxb-cell { position: relative; }',
  '.cxb-cell.cxb-selected { outline: 2px solid #2f6feb; outline-offset: -1px; z-index: 1; }',
  '.cxb-cell .cxd-panel-title { cursor: grab; user-select: none; display: flex; align-items: center; gap: 6px; }',
  '.cxb-tools { margin-left: auto; display: inline-flex; gap: 2px; }',
  '.cxb-tool { width: 26px; height: 26px; line-height: 24px; text-align: center; border-radius: 5px;',
  '  cursor: pointer; font-size: 17px; color: var(--cxd-muted,#6b7280); }',
  '.cxb-tool:hover { background: rgba(0,0,0,.08); color: inherit; }',
  '.cxb-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;',
  '  background: linear-gradient(135deg, transparent 50%, #2f6feb 50%); border-bottom-right-radius: 8px; z-index: 2;',
  '  opacity: 0; transition: opacity .12s ease; }',
  '.cxb-cell:hover .cxb-resize, .cxb-cell.cxb-selected .cxb-resize { opacity: 1; }',
  '.cxb-msg { font-size: 12px; color: var(--cxd-muted,#8a9099); min-height: 16px; }',
  /* Add-data modal */
  '.cxb-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10000;',
  '  display: flex; align-items: center; justify-content: center; padding: 20px; }',
  '.cxb-modal { width: 100%; max-width: 460px; background: var(--cxd-panel-bg,#fff); color: inherit;',
  '  border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.25); padding: 18px 18px 14px;',
  '  display: flex; flex-direction: column; gap: 12px; font-family: system-ui, sans-serif; }',
  '.cxb-modal-title { margin: 0; font-size: 16px; }',
  '.cxb-modal-field { display: flex; flex-direction: column; gap: 4px; }',
  '.cxb-modal-field label { font: 600 11px system-ui; text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted,#8a9099); }',
  '.cxb-modal input, .cxb-modal select, .cxb-modal textarea { width: 100%; box-sizing: border-box;',
  '  padding: 7px 9px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px; font: inherit;',
  '  background: var(--cxd-panel-bg,#fff); color: inherit; }',
  '.cxb-modal-json { font-family: ui-monospace, Menlo, monospace; font-size: 12px; min-height: 130px; resize: vertical; }',
  '.cxb-modal-err { color: var(--cxd-error,#c0392b); font-size: 12px; min-height: 15px; }',
  '.cxb-modal-footer { display: flex; justify-content: flex-end; gap: 8px; }'
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
