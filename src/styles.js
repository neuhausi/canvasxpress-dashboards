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
  '    --cxd-title-bg: #1d2027; --cxd-muted: #7d848f; } }'
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
