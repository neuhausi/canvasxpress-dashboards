/**
 * The dashboard grid stylesheet, exported as a string and as an injector so the
 * renderer stays fully self-contained (no external CSS file to load).
 *
 * @module styles
 */

import { uiTokenCss } from './uiTokens.js';

/**
 * The dashboard CSS. It is built on the CanvasXpress engine's design tokens (the --cx-ui-* roles
 * and --cx-* primitive steps from canvasXpress.css; spec: canvas-ai
 * docs/architecture/widgets/ui-design-tokens.md), so dashboards and charts share one look.
 * uiTokenCss is a generated, zero-specificity fallback of those tokens for pages that do not
 * load canvasXpress.css.
 *
 * @type {string}
 */
export var dashboardCss = [
  uiTokenCss,
  // The dashboards' own properties default to the shared roles. applyPanelColor, the spec's
  // fontName and contrastingBorder still override them per dashboard (on the container), and
  // a theme container (data-cx-ui-theme, set by applyTheme) re-declares them, so they resolve
  // against ITS roles -- dark in a dark dashboard (a custom property resolves where declared).
  ':where(:root, [data-cx-ui-theme]) { --cxd-border: var(--cx-ui-border); --cxd-panel-bg: var(--cx-ui-surface); --cxd-title: var(--cx-ui-text);',
  '  --cxd-title-bg: var(--cx-ui-surface-sunken); --cxd-muted: var(--cx-ui-text-muted); --cxd-ctrl-bg: var(--cx-ui-surface);',
  '  --cxd-error: var(--cx-ui-danger); --cxd-font: var(--cx-font-sans); }',
  // Every dropdown in a dashboard, the builder and its dialogs draws the engine's chevron (two
  // currentColor diagonals: it follows the text colour in light and dark), inset from the right
  // border instead of on it, with room so the text never runs under it. Scoped to our roots (a
  // host page keeps its own selects); the engine's own selects (customizer, data filter,
  // its classed dropdowns) keep their styling.
  ':is(.cxd-dashboard, .cxb, .cxb-topbar, .cxb-modal-overlay, .cxd-code-backdrop) select:not([multiple]):not([size]):not([class*="cX-"]):not([class*="CanvasXpress"]):not(:where([class*="cX-Customizer"], [class*="cX-DataFilter"]) select) {',
  '  -webkit-appearance: none; -moz-appearance: none; appearance: none; padding-right: 30px; cursor: pointer;',
  '  background-image: linear-gradient(45deg, transparent 40%, currentColor 40%, currentColor 60%, transparent 60%), linear-gradient(-45deg, transparent 40%, currentColor 40%, currentColor 60%, transparent 60%);',
  '  background-position: calc(100% - 17px) 50%, calc(100% - 12px) 50%; background-size: 5px 5px, 5px 5px; background-repeat: no-repeat; }',
  '@media (forced-colors: active) { :is(.cxd-dashboard, .cxb, .cxb-topbar, .cxb-modal-overlay, .cxd-code-backdrop) select { -webkit-appearance: auto; appearance: auto; background-image: none; } }',
  // --cxd-ctrl-border is NOT aliased here: it falls back to --cxd-border at the use site, so it
  // follows a dark theme's --cxd-border (a custom property resolves where it is declared).
  '.cxd-dashboard { box-sizing: border-box; width: 100%; }',
  // A dark dashboard paints its own backdrop: embedded in a light host page, its dark-theme text
  // would otherwise sit on the host's white (the spec background, set inline, still wins).
  '.cxd-dashboard[data-cx-ui-theme="dark"] { background-color: var(--cx-ui-surface-sunken); }',
  '@media (prefers-color-scheme: dark) { .cxd-dashboard[data-cx-ui-theme="auto"] { background-color: var(--cx-ui-surface-sunken); } }',
  '.cxd-dashboard *, .cxd-dashboard *::before, .cxd-dashboard *::after { box-sizing: border-box; }',
  // Builder modals are appended to <body>, outside .cxd-dashboard: they relied on the engine's
  // page-wide * { box-sizing } rule, which the engine now scopes to its own DOM.
  '.cxb-modal-overlay, .cxb-modal-overlay *, .cxb-modal-overlay *::before, .cxb-modal-overlay *::after { box-sizing: border-box; }',
  '.cxd-grid { width: 100%; }',
  '.cxd-panel { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0;',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-lg); overflow: hidden;',
  '  background: var(--cxd-panel-bg); }',
  '.cxd-panel-title { flex: 0 0 auto; padding: 6px 10px; font: 600 16px/1.3 var(--cxd-font);',
  '  color: var(--cxd-title); border-bottom: 1px solid var(--cxd-border);',
  '  background: var(--cxd-title-bg); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  // "Code" button on a chart fed by a data function, and the recipe dialog it opens.
  '.cxd-panel-title-actions { display: flex; align-items: center; gap: 8px; }',
  '.cxd-panel-title-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }',
  '.cxd-code-btn { flex: 0 0 auto; padding: 1px 8px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md);',
  '  background: var(--cxd-panel-bg); color: var(--cxd-muted); font: 500 12px/1.5 var(--cx-font-mono); cursor: pointer; }',
  '.cxd-code-btn:hover { color: var(--cxd-title); border-color: var(--cxd-muted); }',
  // Transparent, click-through backdrop: the dialog floats over the dashboard so',
  // the chart stays visible (and the dialog can be dragged aside to watch it',
  // update). The dialog itself re-enables pointer events.',
  '.cxd-code-backdrop { position: fixed; inset: 0; z-index: var(--cx-z-modal); display: flex; align-items: center; justify-content: center;',
  '  padding: 16px; background: transparent; pointer-events: none; }',
  '.cxd-code-dialog { display: flex; flex-direction: column; width: min(760px, 100%); max-height: min(85vh, 900px);',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-lg); background: var(--cxd-panel-bg);',
  '  color: var(--cxd-title); box-shadow: var(--cx-shadow-3); font: 14px/1.45 var(--cxd-font); pointer-events: auto; }',
  '.cxd-code-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--cxd-border); cursor: move; }',
  '.cxd-code-heading { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.cxd-code-close { border: none; background: none; color: var(--cxd-muted); font-size: 22px; line-height: 1; cursor: pointer; }',
  '.cxd-code-body { overflow: auto; padding: 6px 14px 14px; }',
  '.cxd-code-step { padding-top: 10px; }',
  '.cxd-code-step-title { font-weight: 600; }',
  '.cxd-code-step-detail { color: var(--cxd-muted); font-size: 13px; margin-top: 2px; }',
  // The source / language picker in the code dialog: the box (padding, border,
  // radius, surface, text, font) to match the dashboards dropdowns — the shared
  // :is(...) select rule above only adds the appearance + chevron.
  '.cxd-code-backdrop select { margin-left: 6px; padding: 5px 30px 5px 8px; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); background: var(--cx-ui-surface); color: var(--cx-ui-text); font: inherit; }',
  '.cxd-code-backdrop select:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: 1px; }',
  '.cxd-code-block { position: relative; margin-top: 6px; }',
  '.cxd-code-block pre { margin: 0; padding: 10px 12px; overflow: auto; max-height: 340px; border-radius: var(--cx-radius-md);',
  '  border: 1px solid var(--cxd-border); background: var(--cxd-title-bg);',
  '  font: 12.5px/1.5 var(--cx-font-mono); white-space: pre; tab-size: 2; }',
  '.cxd-code-copy { position: absolute; top: 6px; right: 6px; padding: 1px 8px; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); background: var(--cxd-panel-bg); color: var(--cxd-muted); font-size: 12px; cursor: pointer; }',
  /* Floating "Reset cross-filter" control, shown only while a filter-mode
     selection is narrowing the dashboard (markingMode:"filter"). */
  '.cxd-xfilter-reset { position: fixed; right: 16px; bottom: var(--cxd-pill-bottom, 16px); z-index: var(--cx-z-modal);',
  '  padding: 7px 14px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-pill);',
  '  background: var(--cxd-panel-bg); color: inherit; font: 600 12.5px/1.3 var(--cxd-font);',
  '  cursor: pointer; box-shadow: var(--cx-shadow-2); }',
  '.cxd-xfilter-reset:hover { background: var(--cxd-title-bg); }',
  '.cxd-xfilter-reset:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: 2px; }',
  /* The bottom-strip controls (Comments, Ask, Reset cross-filter) share --cxd-pill-bottom
     (default 16px) so a host page can center them in its own bottom strip. */
  /* Collaboration: comments toggle + slide-in rail (hosted app only). */
  '.cxd-comments-toggle { position: fixed; left: 16px; bottom: var(--cxd-pill-bottom, 16px); z-index: var(--cx-z-modal);',
  '  display: inline-flex; align-items: center; gap: 7px; padding: 7px 14px;',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-pill);',
  '  background: var(--cxd-panel-bg); color: inherit; font: 600 12.5px/1.3 var(--cxd-font);',
  '  cursor: pointer; box-shadow: var(--cx-shadow-2); }',
  '.cxd-comments-toggle:hover { background: var(--cxd-title-bg); }',
  '.cxd-comments-toggle:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: 2px; }',
  '.cxd-comments-toggle.cxd-comments-open { background: var(--cx-ui-accent); color: var(--cx-ui-on-accent); border-color: var(--cx-ui-accent); }',
  '.cxd-comments-count { min-width: 18px; padding: 0 5px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cx-ui-accent); color: var(--cx-ui-on-accent); font-size: 11px; text-align: center; }',
  // The panels set display:flex, which would override the `hidden` attribute (so
  // close() could not hide them). Re-assert none when hidden so they truly collapse,
  // leaving only the always-visible toggle pills.
  '.cxd-comments-rail[hidden], .cxd-ask-panel[hidden] { display: none; }',
  '.cxd-comments-rail { position: fixed; top: 0; right: 0; bottom: 0; width: 340px; max-width: 92vw;',
  '  z-index: var(--cx-z-modal); display: flex; flex-direction: column;',
  '  background: var(--cxd-panel-bg); border-left: 1px solid var(--cxd-border); box-shadow: var(--cx-shadow-3);',
  '  font: 13px/1.5 var(--cxd-font); color: inherit; }',
  '.cxd-comments-head { display: flex; align-items: center; justify-content: space-between;',
  '  padding: 12px 14px; border-bottom: 1px solid var(--cxd-border); }',
  '.cxd-comments-title { margin: 0; font-size: 15px; }',
  '.cxd-comments-close { border: none; background: none; color: var(--cxd-muted); font-size: 22px; line-height: 1; cursor: pointer; }',
  '.cxd-comments-list { flex: 1 1 auto; overflow-y: auto; padding: 10px 14px; }',
  '.cxd-comments-empty { color: var(--cxd-muted); padding: 24px 4px; text-align: center; }',
  '.cxd-comments-error { background: var(--cx-ui-danger-tint); color: var(--cx-ui-danger); padding: 6px 10px;',
  '  border-radius: var(--cx-radius-sm); margin-bottom: 8px; font-size: 12.5px; }',
  '.cxd-cmt { padding: 9px 0; border-bottom: 1px solid var(--cxd-border); }',
  '.cxd-cmt-reply { margin-left: 16px; padding-left: 10px; border-left: 2px solid var(--cxd-border); border-bottom: none; }',
  '.cxd-cmt-resolved { opacity: .6; }',
  '.cxd-cmt-meta { display: flex; align-items: baseline; gap: 8px; }',
  '.cxd-cmt-author { font-weight: 600; }',
  '.cxd-cmt-time { color: var(--cxd-muted); font-size: 11.5px; }',
  '.cxd-cmt-badge { margin-left: auto; padding: 0 7px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cxd-title-bg); color: var(--cxd-muted); font-size: 11px; }',
  '.cxd-cmt-anchor { padding: 0 7px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cx-ui-accent-tint); color: var(--cx-ui-accent); font-size: 11px; }',
  '.cxd-comments-anchor { width: 100%; box-sizing: border-box; padding: 5px 8px;',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); background: var(--cxd-title-bg); color: inherit; font: inherit; }',
  '.cxd-cmt-body { margin: 3px 0 5px; white-space: pre-wrap; word-break: break-word; }',
  '.cxd-cmt-mention { color: var(--cx-ui-accent); font-weight: 600; }',
  '.cxd-cmt-actions { display: flex; gap: 12px; }',
  '.cxd-cmt-link { border: none; background: none; color: var(--cx-ui-accent); font: inherit; font-size: 12px; cursor: pointer; padding: 0; }',
  '.cxd-cmt-link:hover { text-decoration: underline; }',
  '.cxd-cmt-del { color: var(--cx-ui-danger); }',
  '.cxd-cmt-link:disabled { opacity: .5; cursor: default; text-decoration: none; }',
  '.cxd-comments-composer, .cxd-cmt-replybox { display: flex; flex-direction: column; gap: 6px; }',
  '.cxd-comments-composer { padding: 10px 14px; border-top: 1px solid var(--cxd-border); }',
  '.cxd-cmt-replybox { margin: 8px 0 2px; }',
  '.cxd-comments-input { width: 100%; box-sizing: border-box; resize: vertical; padding: 7px 9px;',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); background: var(--cxd-title-bg); color: inherit; font: inherit; }',
  '.cxd-comments-input:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: -1px; }',
  '.cxd-comments-send { align-self: flex-end; padding: 5px 14px; border: none; border-radius: var(--cx-radius-md);',
  '  background: var(--cx-ui-accent-strong); color: var(--cx-ui-on-accent); font: 600 12.5px/1.4 var(--cxd-font); cursor: pointer; }',
  '.cxd-comments-send:disabled { opacity: .5; cursor: default; }',
  /* Proactive insights: a strip of captions above the dashboard, each with the figures behind it. */
  '.cxd-storyboard { margin: 0 0 12px; padding: 10px 14px; background: var(--cxd-panel-bg); border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); font-family: var(--cxd-font); position: sticky; top: 0; z-index: var(--cx-z-raised); }',
  '.cxd-sb-head { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }',
  '.cxd-sb-btn { min-width: 28px; height: 28px; padding: 0 8px; background: var(--cxd-ctrl-bg); color: var(--cxd-muted);',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); cursor: pointer; font: inherit; }',
  '.cxd-sb-btn:disabled { opacity: 0.4; cursor: default; }',
  '.cxd-sb-count { color: var(--cxd-muted); font-size: 12px; }',
  '.cxd-sb-title { font-weight: 600; }',
  '.cxd-sb-dots { display: inline-flex; gap: 6px; margin-left: auto; }',
  '.cxd-sb-dot { width: 10px; height: 10px; padding: 0; border: 1px solid var(--cxd-muted); border-radius: var(--cx-radius-pill);',
  '  background: transparent; cursor: pointer; }',
  '.cxd-sb-dot--on { background: var(--cx-ui-accent-strong); border-color: var(--cx-ui-accent-strong); }',
  '.cxd-sb-text { margin: 8px 0 0; line-height: 1.5; }',
  '.cxd-insights { margin: 0 0 12px; padding: 10px 14px; background: var(--cxd-panel-bg); border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); font: 13px/1.5 var(--cxd-font); color: inherit; }',
  '.cxd-insights-head { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; }',
  '.cxd-insights-title { font-weight: 600; }',
  '.cxd-insights-note { color: var(--cxd-muted); font-size: 12px; }',
  '.cxd-insights-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }',
  '.cxd-insight { display: flex; gap: 8px; align-items: flex-start; }',
  '.cxd-insight-dot { flex: 0 0 auto; width: 8px; height: 8px; margin-top: 7px; border-radius: var(--cx-radius-pill); background: var(--cx-ui-accent); }',
  '.cxd-insight--warn .cxd-insight-dot { background: var(--cxd-error); }',
  '.cxd-insight-body { min-width: 0; }',
  '.cxd-insight-ids { display: inline-flex; flex-wrap: wrap; gap: 4px; margin-left: 6px; vertical-align: baseline; }',
  '.cxd-insight-id { padding: 0 8px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-pill); background: var(--cxd-title-bg);',
  '  color: inherit; font: 600 12px/1.6 var(--cxd-font); cursor: pointer; }',
  '.cxd-insight-id:hover { background: var(--cx-ui-accent); color: var(--cx-ui-on-accent); border-color: var(--cx-ui-accent); }',
  '.cxd-insight-id:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: 1px; }',
  '.cxd-insight details { margin-top: 2px; color: var(--cxd-muted); font-size: 12px; }',
  '.cxd-insight summary { cursor: pointer; }',
  '.cxd-insight-figures { margin: 4px 0 0; white-space: pre-wrap; font: 12px/1.5 var(--cx-font-mono, ui-monospace, monospace); }',
  /* View-time Q&A: the "Ask" toggle + popover. */
  '.cxd-ask-toggle { position: fixed; left: 150px; bottom: var(--cxd-pill-bottom, 16px); z-index: var(--cx-z-modal);',
  '  display: inline-flex; align-items: center; gap: 7px;',
  '  padding: 7px 14px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-pill);',
  '  background: var(--cxd-panel-bg); color: inherit; font: 600 12.5px/1.3 var(--cxd-font);',
  '  cursor: pointer; box-shadow: var(--cx-shadow-2); }',
  '.cxd-ask-toggle:hover { background: var(--cxd-title-bg); }',
  '.cxd-ask-toggle:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: 2px; }',
  '.cxd-ask-toggle.cxd-ask-open { background: var(--cx-ui-accent); color: var(--cx-ui-on-accent); border-color: var(--cx-ui-accent); }',
  '.cxd-ask-count { min-width: 18px; padding: 0 5px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cx-ui-accent); color: var(--cx-ui-on-accent); font-size: 11px; text-align: center; }',
  '.cxd-ask-toggle.cxd-ask-open .cxd-ask-count { background: var(--cx-ui-on-accent); color: var(--cx-ui-accent); }',
  '.cxd-ask-panel { position: fixed; left: 16px; bottom: calc(var(--cxd-pill-bottom, 16px) + 42px); width: 360px; max-width: 92vw; max-height: 72vh;',
  '  z-index: var(--cx-z-modal); display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;',
  '  background: var(--cxd-panel-bg); border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-lg);',
  '  box-shadow: var(--cx-shadow-3); font: 13px/1.5 var(--cxd-font); color: inherit; }',
  '.cxd-ask-head { display: flex; align-items: center; justify-content: space-between; }',
  '.cxd-ask-title { font-weight: 600; }',
  '.cxd-ask-close { border: none; background: none; color: var(--cxd-muted); font-size: 20px; line-height: 1; cursor: pointer; }',
  '.cxd-ask-form { display: flex; flex-direction: column; gap: 6px; }',
  '.cxd-ask-input { width: 100%; box-sizing: border-box; resize: vertical; padding: 7px 9px;',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); background: var(--cxd-title-bg); color: inherit; font: inherit; }',
  '.cxd-ask-input:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: -1px; }',
  '.cxd-ask-send { align-self: flex-end; padding: 5px 14px; border: none; border-radius: var(--cx-radius-md);',
  '  background: var(--cx-ui-accent-strong); color: var(--cx-ui-on-accent); font: 600 12.5px/1.4 var(--cxd-font); cursor: pointer; }',
  '.cxd-ask-send:disabled { opacity: .5; cursor: default; }',
  '.cxd-ask-history { flex: 1 1 auto; overflow-y: auto; min-height: 0; }',
  '.cxd-ask-history:empty { display: none; }',
  '.cxd-ask-status-line { font-size: 12.5px; }',
  '.cxd-ask-status { color: var(--cxd-muted); }',
  '.cxd-ask-error { color: var(--cx-ui-danger); }',
  '.cxd-ask-entry { padding: 8px 0; border-top: 1px solid var(--cxd-border); }',
  '.cxd-ask-entry:first-child { border-top: none; }',
  '.cxd-ask-q { font-weight: 600; margin-bottom: 3px; }',
  '.cxd-ask-qmark { display: inline-block; min-width: 16px; padding: 0 5px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cx-ui-accent-tint); color: var(--cx-ui-accent); font-size: 11px; }',
  '.cxd-ask-text { margin: 2px 0; white-space: pre-wrap; word-break: break-word; }',
  '.cxd-ask-used { font-size: 12px; color: var(--cxd-muted); }',
  '.cxd-ask-used summary { cursor: pointer; }',
  '.cxd-ask-usedlist { margin: 4px 0 0; padding-left: 18px; }',
  '.cxd-ask-entrymeta { display: flex; align-items: center; gap: 10px; margin-top: 4px; }',
  '.cxd-ask-author { font-size: 11.5px; font-weight: 600; color: var(--cxd-muted); }',
  '.cxd-ask-time { font-size: 11px; color: var(--cxd-muted); }',
  '.cxd-ask-pin { border: none; background: none; color: var(--cx-ui-accent); font: inherit; font-size: 11.5px; cursor: pointer; padding: 0; }',
  '.cxd-ask-pin:hover { text-decoration: underline; }',
  '.cxd-ask-pin:disabled { color: var(--cxd-muted); cursor: default; text-decoration: none; }',
  '.cxd-ask-del { margin-left: auto; border: none; background: none; color: var(--cx-ui-danger); font: inherit; font-size: 11.5px; cursor: pointer; padding: 0; }',
  '.cxd-ask-del:hover { text-decoration: underline; }',
  '.cxd-code-edit { display: block; width: 100%; box-sizing: border-box; padding: 10px 12px; resize: vertical; border-radius: var(--cx-radius-md);',
  '  border: 1px solid var(--cxd-border); background: var(--cxd-title-bg); color: inherit;',
  '  font: 12.5px/1.5 var(--cx-font-mono); white-space: pre; tab-size: 2; }',
  '.cxd-code-edit:focus { outline: 2px solid var(--cx-ui-focus); outline-offset: -1px; }',
  '.cxd-code-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; margin-top: 6px; }',
  '.cxd-code-status { font-size: 12.5px; color: var(--cxd-muted); }',
  '.cxd-code-status.cxd-code-error { color: var(--cxd-error); }',
  '.cxd-code-apply { padding: 4px 14px; border: none; border-radius: var(--cx-radius-md); background: var(--cx-ui-accent-strong);',
  '  color: var(--cx-ui-on-accent); font: 600 13px/1.4 var(--cxd-font); cursor: pointer; }',
  '.cxd-code-apply:disabled { opacity: .45; cursor: not-allowed; }',
  '.cxd-code-edit[readonly] { cursor: text; }',
  '.cxd-code-edit[readonly]:focus { outline: 1px dashed var(--cxd-border); }',
  /* In the builder the title-bar Code button sits under the floating panel
     toolbar; the builder offers it (editable) from that toolbar instead. */
  '.cxb-cell .cxd-code-btn { display: none; }',
  // Centre the graph canvas in the body so any leftover space (the few px a
  // graph leaves, or a reserved canvasInset margin) is even on ALL sides rather
  // than pooling at the right and bottom. Text/control panels set their own
  // inline flex alignment (applyAlignment), which overrides this.
  '.cxd-panel-body { position: relative; flex: 1 1 auto; min-height: 0;',
  '  display: flex; align-items: center; justify-content: center; }',
  // Provenance figure-legend footer: the auto-derived method line beneath a panel.
  '.cxd-panel-footer { flex: 0 0 auto; padding: 4px 10px; font: 400 11.5px/1.4 var(--cxd-font);',
  '  color: var(--cxd-muted); border-top: 1px solid var(--cxd-border); background: var(--cxd-title-bg);',
  '  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.cxd-text { width: 100%; height: 100%; padding: 5px 12px; overflow: auto;',
  '  font: 16px/1.35 var(--cxd-font); color: var(--cxd-title); white-space: pre-wrap; word-break: break-word; }',
  // Text elements are chrome-free by default (no border/background) so they sit
  // on the dashboard background; an explicit panel.bg fills the cell instead.
  '.cxd-text-cell { border: none; background: transparent; z-index: 2; }',
  // Image elements: the picture fills the cell and scales via object-fit; the
  // cell is chrome-free like text. It resizes with the cell (its grid span).
  '.cxd-image-cell { border: none; background: transparent; z-index: 2; overflow: hidden; }',
  '.cxd-image { display: block; width: 100%; height: 100%; object-fit: contain; }',
  '.cxd-image-link { display: block; width: 100%; height: 100%; }',
  '.cxd-image-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;',
  '  padding: 8px; text-align: center; box-sizing: border-box; color: var(--cxd-muted);',
  '  font: 13px/1.4 var(--cxd-font); border: 1px dashed var(--cxd-border); border-radius: var(--cx-radius-lg); }',
  // Annotation-filter controls float free like text: a chrome-less cell holding
  // a compact pill widget, so it reads cleanly when overlapping a graph.
  // Free-floating cells (text/control) stack ABOVE solid panels (z-index) —
  // collision resolution lets graphs compact through their rows, and without
  // the raise a control ends up hidden behind whichever panel slid over it.
  '.cxd-annctl-cell { border: none; background: transparent; overflow: visible; z-index: 3; }',
  /* While a chart is maximized / in its customizer / data filters, CanvasXpress
     marks <body> .has-fullscreen and fixes that chart's DOM over the page at
     z-index 1 (it hides other CanvasXpress charts itself). Cells that carry a
     z-index (text, image, controls, a selected builder cell) would otherwise
     paint over it — or, for the chart's own cell, trap it in a stacking context
     below its neighbours — so drop every cell's z-index for the duration. */
  'body.has-fullscreen .cxd-panel { z-index: auto !important; }',
  // Filters panel: a titled panel whose body scrolls a stack of field sections.
  '.cxd-filters-cell .cxd-panel-body { align-items: stretch; justify-content: flex-start; overflow: auto; }',
  '.cxd-filters { width: 100%; padding: 8px 10px; font: 13px/1.35 var(--cxd-font); color: var(--cxd-title); }',
  '.cxd-filters-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }',
  '.cxd-filters-bar select, .cxd-filters-bar input:not(:where([type=checkbox], [type=radio])), .cxd-filters-bar button, .cxd-filters-range-plain input, .cxd-filters-text {',
  '  padding: 3px 6px; border: 1px solid var(--cxd-ctrl-border, var(--cxd-border)); border-radius: var(--cx-radius-md);',
  '  font: inherit; background: var(--cxd-ctrl-bg); color: inherit; }',
  '.cxd-filters-scheme-name { width: 110px; }',
  '.cxd-filters-bar button { cursor: pointer; }',
  /* Field cards in the CanvasXpress Data Filter's style (13-datafilter.css). The
     elements also carry the Data Filter's own classes (cX-DataFilter-Container-
     Hoverable, cX-DataFilter-Search, cX-DataFilter-Container-Mask-NoOverflow,
     cX-Checkbox, cX-Checkbox-Label, cX-DataFilter-Count), so they follow the loaded
     CanvasXpress theme; these rules repeat its values through the same --cx-*
     variables (fallbacks = its :root defaults), so a page without canvasXpress.css
     looks the same, and adapt the two rules meant for the chart's fixed-width
     sidebar (a 220px label, a list that clips instead of scrolling). */
  '.cxd-filters { --cxd-df-accent: var(--cx-datafilter-border-color, var(--cx-ui-border-accent)); --cxd-df-text: var(--cx-datafilter-text-color, var(--cx-ui-text));',
  '  --cxd-df-bg: var(--cx-datafilter-background-color, var(--cx-ui-surface)); --cxd-df-hover: var(--cx-datafilter-hover-color, var(--cx-ui-accent-tint)); }',
  // Dark comes from the roles: a dark dashboard (data-cx-ui-theme) swaps them, so the cards follow.
  '.cxd-filters .cxd-filters-field { box-sizing: border-box; margin: 2px 2px 6px; padding: 0 0 4px;',
  '  border: 1px solid var(--cxd-df-accent); border-radius: var(--cx-border-radius, 5px); }',
  '.cxd-filters .cxd-filters-field:hover { background-color: var(--cxd-df-hover); }',
  '.cxd-filters .cxd-filters-label { padding: 7px 10px 5px 25px; font-size: 13px; color: var(--cxd-df-text); }',
  '.cxd-filters input.cX-DataFilter-Search { box-sizing: border-box; display: block; width: calc(100% - 10px); height: 32px;',
  '  margin: 0 5px 4px; padding: 0 0 0 7px; font: inherit; font-size: var(--cx-datafilter-font-size, 12px);',
  '  color: var(--cxd-df-text); background: var(--cxd-df-bg);',
  '  border: 1px solid var(--cxd-df-accent); border-radius: var(--cx-border-radius, 5px); outline: none; }',
  '.cxd-filters input.cxd-filters-find { width: calc(100% - 4px); margin: 0 2px 8px; }',
  '.cxd-filters .cxd-filters-values { box-sizing: border-box; margin: 0 5px; padding: 2px 0; max-height: 184px; overflow-x: hidden; overflow-y: auto;',
  '  border: 1px solid var(--cxd-df-accent); background: var(--cxd-df-bg); }',
  '.cxd-filters .cxd-filters-check { position: relative; display: flex; align-items: center; min-height: 20px; padding: 0 46px 0 4px;',
  '  font-size: var(--cx-datafilter-font-size, 12px); color: var(--cxd-df-text); }',
  // The shared CanvasXpress checkbox (.cX-UI-Controls); only the list's size and spacing here
  '.cxd-filters .cxd-filters-check input[type=checkbox] { flex-shrink: 0; width: 14px; height: 14px; margin: 2px; }',
  '.cxd-filters label.cxd-filters-name { flex: 1 1 auto; width: auto; min-width: 0; margin: 0 0 0 3px !important; cursor: pointer;',
  '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  '.cxd-filters .cX-DataFilter-Count { position: absolute; right: 6px; top: 0; line-height: 20px; font-size: 11px; opacity: .6; pointer-events: none; }',
  '.cxd-filters .cxd-filters-field .cxd-filters-range { padding: 2px 14px 0; }',
  '.cxd-filters-range-plain { display: flex; align-items: center; gap: 6px; }',
  '.cxd-filters-range-plain input { width: 0; flex: 1 1 0; min-width: 60px; }',
  /* Range slider, styled like the CanvasXpress Data Filter range (15-range-slider.css):
     values on top, a thick accent bar with round thumbs, a tick ruler below. The
     accent follows the engine theme (--cx-toggle-switch-background-color, set on
     :root by canvasXpress.css). Two invisible native range inputs sit over the
     track and take the drags; only their thumbs catch the pointer. Selectors are
     qualified with input[type=range] to outrank canvasXpress.css's global
     `input[type=range]` rules. */
  '.cxd-filters-range { padding: 0 10px 2px; --cxd-accent: var(--cx-toggle-switch-background-color, var(--cx-ui-control-on)); }',
  '.cxd-range-values { display: flex; justify-content: space-between; margin: 0 -10px 6px; }',
  '.cxd-range-values input { width: 45%; padding: 2px 0; border: none; border-radius: var(--cx-radius-sm); background: transparent;',
  '  font: 15px/1.2 var(--cxd-font); color: inherit; -moz-appearance: textfield; }',
  '.cxd-range-values input:focus { outline: 1px solid var(--cxd-accent); background: var(--cxd-ctrl-bg); }',
  '.cxd-range-values input.cxd-filters-max { text-align: right; }',
  '.cxd-range-values input::-webkit-inner-spin-button, .cxd-range-values input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }',
  '.cxd-range-slider { position: relative; height: 8px; margin: 5px 0; isolation: isolate; }',
  '.cxd-range-track { position: absolute; inset: 0; border-radius: var(--cx-radius-sm); background: var(--cxd-border); }',
  '.cxd-range-fill { position: absolute; top: 0; bottom: 0; left: 0; right: 0; border-radius: var(--cx-radius-sm); background: var(--cxd-accent); }',
  '.cxd-range-thumb { position: absolute; top: 50%; width: 18px; height: 18px; margin: -9px 0 0 -9px; border-radius: 50%;',
  '  background: var(--cxd-accent); box-shadow: 0 0 0 0 var(--cx-ui-accent-tint); transition: box-shadow .15s ease-in-out; pointer-events: none; }',
  '.cxd-range-slider:hover .cxd-range-thumb { box-shadow: 0 0 0 6px var(--cx-ui-accent-tint); }',
  'input[type=range].cxd-range-input { position: absolute; z-index: 3; left: -9px; top: -5px; width: calc(100% + 18px); height: 18px;',
  '  margin: 0; padding: 0; opacity: 0; pointer-events: none; -webkit-appearance: none; appearance: none; background: none; }',
  'input[type=range].cxd-range-input::-webkit-slider-thumb { pointer-events: all; width: 18px; height: 18px; border-radius: 50%;',
  '  cursor: grab; -webkit-appearance: none; appearance: none; }',
  'input[type=range].cxd-range-input::-moz-range-thumb { pointer-events: all; width: 18px; height: 18px; border: 0; border-radius: 50%; cursor: grab; }',
  '.cxd-range-ticks { position: relative; height: 26px; margin-top: 8px; }',
  '.cxd-range-tick { position: absolute; top: 0; width: 1px; height: 5px; background: var(--cxd-accent); }',
  '.cxd-range-tick-major { height: 10px; }',
  '.cxd-range-tick-label { position: absolute; top: 11px; left: 0; transform: translateX(-50%); white-space: nowrap;',
  '  font-size: 12px; line-height: 1.2; color: inherit; }',
  '.cxd-filters-text { width: 100%; }',
  '.cxd-filters .cxd-filters-field input.cxd-filters-text { width: calc(100% - 10px); }',
  '.cxd-filters-hint { color: var(--cxd-muted); }',
  '.cxd-annctl { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; max-width: 100%;',
  '  padding: 5px 0; background: transparent;',
  '  font: 14px/1.3 var(--cxd-font); color: var(--cxd-title); }',
  '.cxd-annctl-label { font-weight: 600; white-space: nowrap; }',
  '.cxd-annctl-hint { color: var(--cxd-muted); }',
  '.cxd-annctl-disabled { opacity: 0.65; }',
  // Controls use --cxd-ctrl-border (a colour the renderer computes to contrast
  // with whatever the control sits on) so the box stays visible even when the
  // panel chrome is coordinated to the background. Falls back to the theme border.
  // The search box (a text <input>) shares the SAME box as the select dropdowns so
  // the explorer controls read as one consistent set.
  '.cxd-annctl-select, .cxd-annctl-search { padding: 4px 7px; border: 1px solid var(--cxd-ctrl-border, var(--cxd-border)); border-radius: var(--cx-radius-md);',
  '  font: inherit; background: var(--cxd-panel-bg); color: inherit; }',
  // Strip the native search-input chrome so its box matches the select; keep a sensible width.
  '.cxd-annctl-search { min-width: 140px; -webkit-appearance: none; appearance: none; }',
  '.cxd-annctl-radios { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
  '.cxd-annctl-radio { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }',
  '.cxd-annctl-seg { display: inline-flex; border: 1px solid var(--cxd-ctrl-border, var(--cxd-border)); border-radius: var(--cx-radius-md); overflow: hidden; }',
  '.cxd-annctl-segbtn { padding: 4px 11px; border: none; border-right: 1px solid var(--cxd-ctrl-border, var(--cxd-border));',
  '  background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }',
  '.cxd-annctl-segbtn:last-child { border-right: none; }',
  '.cxd-annctl-segbtn:hover { background: var(--cx-ui-accent-tint); }',
  '.cxd-annctl-segbtn.cxd-annctl-on { background: var(--cx-ui-accent-strong); color: var(--cx-ui-on-accent); }',
  /* config-control slider. canvasXpress.css (15-range-slider.css) styles EVERY
     input[type=range] absolute/invisible with a red-square thumb for its
     dual-thumb widget — and its `input[type=range]::...` selectors outrank a bare
     `.cxd-slider::...`. Qualify ours with input[type=range] to win the cascade
     and force the slider visible + interactive. */
  'input[type=range].cxd-slider { position: static; pointer-events: auto; opacity: 1;',
  '  -webkit-appearance: none; appearance: none; width: 220px; max-width: 46vw; height: 20px;',
  '  background: transparent; cursor: pointer; vertical-align: middle; z-index: auto; }',
  'input[type=range].cxd-slider::-webkit-slider-runnable-track { height: 5px; border-radius: var(--cx-radius-sm); background: var(--cxd-ctrl-border, var(--cxd-border)); }',
  'input[type=range].cxd-slider::-moz-range-track { height: 5px; border-radius: var(--cx-radius-sm); background: var(--cxd-ctrl-border, var(--cxd-border)); }',
  'input[type=range].cxd-slider::-webkit-slider-thumb { pointer-events: all; -webkit-appearance: none; appearance: none; margin-top: -6px;',
  '  width: 16px; height: 16px; border-radius: 50%; background: var(--cx-ui-accent); border: 2px solid var(--cx-ui-surface); box-shadow: var(--cx-shadow-1); }',
  'input[type=range].cxd-slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: var(--cx-ui-accent); border: 2px solid var(--cx-ui-surface); box-shadow: var(--cx-shadow-1); }',
  '.cxd-slider-readout { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 120px; white-space: nowrap; }',
  /* when panels reserve a canvas margin, centre the (smaller) graph in the cell */
  '.cxd-inset .cxd-panel-body { display: flex; align-items: center; justify-content: center; }',
  '.cxd-canvas { display: block; width: 100%; height: 100%; }',
  '.cxd-panel-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;',
  '  font: 500 16px var(--cxd-font); color: var(--cxd-muted);',
  '  background: var(--cxd-panel-bg); }',
  '.cxd-panel-overlay.cxd-error { color: var(--cxd-error); padding: 8px; text-align: center; }',
  /* ---- viewer toolbar (examples/view.html + the server's share-link view.html) ---- */
  // One source for both viewer pages (each used to carry an identical copy).
  '.cxd-tb-menu { position: relative; }',
  '.cxd-tb-btn { display: inline-flex; align-items: center; gap: 7px; font: inherit; color: var(--cx-ui-text-muted);',
  '  background: transparent; border: 1px solid transparent; border-radius: var(--cx-radius-md); padding: 6px 10px;',
  '  cursor: pointer; line-height: 1; }',
  '.cxd-tb-btn:hover { background: var(--cx-ui-accent-tint); color: var(--cx-ui-text); }',
  '.cxd-tb-btn svg { width: 16px; height: 16px; display: block; }',
  '.cxd-tb-btn .cxd-caret { width: 11px; height: 11px; opacity: .7; }',
  '.cxd-tb-dropdown { position: absolute; right: 0; top: calc(100% + 6px); z-index: var(--cx-z-popover); min-width: 224px;',
  '  background: var(--cx-ui-surface-raised); color: var(--cx-ui-text); border: 1px solid var(--cx-ui-border-subtle);',
  '  border-radius: var(--cx-radius-lg); box-shadow: var(--cx-shadow-2); padding: 6px; }',
  '.cxd-tb-dropdown[hidden] { display: none; }',
  '.cxd-tb-item { display: flex; align-items: center; gap: 11px; width: 100%; font: inherit; text-align: left;',
  '  color: var(--cx-ui-text); background: transparent; border: 0; border-radius: var(--cx-radius-md); padding: 9px 10px; cursor: pointer; }',
  '.cxd-tb-item:hover { background: var(--cx-ui-accent-tint); }',
  '.cxd-tb-item svg { width: 19px; height: 19px; color: var(--cx-ui-text-muted); flex: 0 0 auto; }',
  '.cxd-tb-item b { font-weight: 600; font-size: 13px; }',
  '.cxd-tb-item small { display: block; color: var(--cx-ui-text-muted); font-size: 11px; margin-top: 1px; }',
  '.cxd-tb-item:disabled { opacity: .5; cursor: default; }',
  // Dark: the page's data-cx-ui-theme swaps the roles these read.
  /* ---- builder (Phase 4) ---- */
  '.cxb { display: flex; flex-direction: column; gap: 10px; font-family: var(--cxd-font); }',
  /* toolbar (host may be an app-shell element) */
  // Two fixed rows: create actions + Save, then the selected element's
  // configuration (always reserved, so the stage never jumps on select).
  '.cxb-topbar { display: flex; flex-direction: column; align-items: stretch; gap: 8px; width: 100%; }',
  '.cxb-trow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
  /* Toolbar drop-downs: one per accent colour (+ Add / Interact / Data). The
     trigger keeps the group's left-edge accent; the panel opens beneath it with
     the same accent along its top edge and the actions as full-width rows. */
  '.cxb-menu { position: relative; display: inline-block; }',
  /* The three triggers share one width (label left, chevron right) so the group reads as a set. */
  '.cxb-menu-trigger { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px; width: 124px; }',
  '.cxb-menu-caret { display: inline-flex; flex: none; width: 18px; height: 18px; opacity: .8; }',
  '.cxb-menu-caret svg { width: 100%; height: 100%; display: block; }',
  '.cxb-menu-panel { display: none; position: absolute; top: calc(100% + 4px); left: 0; min-width: 200px;',
  '  flex-direction: column; gap: 2px; padding: 4px; z-index: var(--cx-z-modal);',
  '  background: var(--cx-ui-surface); border: 1px solid var(--cxd-border); border-top-width: 3px;',
  '  border-radius: var(--cx-radius-md); box-shadow: var(--cx-shadow-2); }',
  '.cxb-menu-open .cxb-menu-panel { display: flex; }',
  '.cxb-menu-add .cxb-menu-panel { border-top-color: var(--cx-color-brand-add); }',
  '.cxb-menu-interact .cxb-menu-panel { border-top-color: var(--cx-color-brand-interact); }',
  '.cxb-menu-data .cxb-menu-panel { border-top-color: var(--cx-color-brand-data); }',
  '.cxb-menu-open > .cxb-menu-trigger { background: var(--cx-ui-surface-sunken); }',
  /* Actions inside a panel read as menu rows, not buttons: borderless, left-aligned. */
  '.cxb-menu-panel .cxb-btn { display: flex; align-items: center; justify-content: flex-start; width: 100%; text-align: left;',
  '  border: 0; border-radius: var(--cx-radius-sm); background: transparent; box-shadow: none; padding: 7px 10px; }',
  /* Menu-item icons: a leading SVG (ordered first, the label stays the button's own
     text), tinted with the group's accent so the colour language carries into the rows. */
  '.cxb-menu-panel .cxb-btn { gap: 10px; }',
  '.cxb-ic { order: -1; display: inline-flex; flex: none; width: 18px; height: 18px; color: var(--cxd-muted); }',
  '.cxb-ic svg { width: 100%; height: 100%; display: block; }',
  /* Icon-only history buttons: full-strength icon (not the muted menu tint), compact padding. */
  '.cxb-icon-btn { display: inline-flex; align-items: center; justify-content: center; padding: 6px 9px; }',
  '.cxb-icon-btn .cxb-ic { order: 0; width: 20px; height: 20px; color: var(--cx-ui-text); }',
  '.cxb-menu-add .cxb-ic { color: var(--cx-color-brand-add); }',
  '.cxb-menu-interact .cxb-ic { color: var(--cx-color-brand-interact); }',
  '.cxb-menu-data .cxb-ic { color: var(--cx-color-brand-data); }',
  '.cxb-menu-add .cxb-menu-panel .cxb-btn:hover:not(:disabled) { background: var(--cx-color-brand-add-a14); }',
  '.cxb-menu-interact .cxb-menu-panel .cxb-btn:hover:not(:disabled) { background: var(--cx-color-brand-interact-a18); }',
  '.cxb-menu-data .cxb-menu-panel .cxb-btn:hover:not(:disabled) { background: var(--cx-color-brand-data-a12); }',
  '.cxb-tgroup { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '.cxb-spacer { flex: 1 1 auto; }',
  '.cxb-tlabel { font: 600 14px var(--cxd-font); text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted); }',
  // The dashboard title takes the free room (so it is not cut off) but yields to the menus.
  '.cxb-title-input { padding: 5px 8px; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); font: 600 16px var(--cxd-font); min-width: 150px; flex: 0 1 320px; }',
  '.cxb-tinput { padding: 5px 8px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md);',
  '  font: inherit; width: 130px; }',
  /* The selected-panel strip: a slim bar attached under the toolbar. Dashed with a
     hint while nothing is selected; solid accent once a panel is. Height is always
     reserved so selecting never shifts the stage. */
  '.cxb-props { min-height: 44px; box-sizing: border-box; padding: 5px 12px; gap: 10px;',
  '  background: var(--cx-ui-surface); border: 1px dashed var(--cxd-border); border-radius: var(--cx-radius-md); }',
  '.cxb-props.cxb-props-active { border-style: solid; border-color: var(--cx-ui-accent); background: var(--cx-ui-accent-tint-subtle); }',
  '.cxb-props-hint { color: var(--cxd-muted); font-size: 14px; }',
  // The panel-name field grows with the free room instead of a fixed 130px.
  '.cxb-props .cxb-tinput { flex: 1 1 150px; width: auto; min-width: 120px; max-width: 300px; }',
  '.cxb-props select { padding: 5px 5px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); font: inherit; }',
  // Compact labels in the props row so a control's full configuration fits on
  // one line in a ~1400px window.
  '.cxb-props .cxb-tlabel { font-size: 12px; }',
  /* Toolbar controls set explicit colours (they render into the host app shell,
     which may be dark) — `color: inherit` here would pick up light shell text on
     the light button and vanish. Dark-scheme overrides are below. */
  // Builder buttons are .cX-Button (+ --primary) from canvasXpress.css (the shared UI primitive);
  // .cxb-btn only keeps the builder toolbar's size (so the builder layout does not move).
  '.cxb-btn { padding: 6px 13px; font-size: 16px; line-height: normal; }',
  /* Toolbar buttons are colour-coded by kind with a left-edge accent (set in
     builder.js), using the three primary colours of the CanvasXpress logo: add
     content = brand blue, add interaction = brand orange, data tools = brand red.
     These hues are design tokens (--cx-color-brand-*, the same on light and dark
     toolbars) so they live in the token layer, not as literals here. A thick left
     border carries the accent and hovering lifts a matching lighter tint; the
     button fill otherwise stays the shared .cX-Button. */
  '.cxb-bt-add { border-left: 4px solid var(--cx-color-brand-add); }',
  '.cxb-bt-interact { border-left: 4px solid var(--cx-color-brand-interact); }',
  '.cxb-bt-data { border-left: 4px solid var(--cx-color-brand-data); }',
  '.cxb-bt-add:hover:not(:disabled) { background: var(--cx-color-brand-add-a14); }',
  '.cxb-bt-interact:hover:not(:disabled) { background: var(--cx-color-brand-interact-a18); }',
  '.cxb-bt-data:hover:not(:disabled) { background: var(--cx-color-brand-data-a12); }',
  // Toolbar inputs on the roles (dark follows the page's data-cx-ui-theme, not the OS)
  '.cxb-title-input, .cxb-tinput, .cxb-props select { background: var(--cx-ui-surface); color: var(--cx-ui-text); }',
  '.cxb-stage { width: 100%; min-width: 0; }',
  /* data-flow card: floats over the stage's top-right, never shifts layout */
  '.cxb { position: relative; }',
  '.cxb-flow { position: absolute; top: 8px; right: 12px; z-index: calc(var(--cx-z-raised) + 10); width: 300px; max-width: 45%;',
  '  background: var(--cx-ui-surface-raised); color: var(--cx-ui-text); border: 1px solid var(--cx-ui-border);',
  '  border-radius: var(--cx-radius-lg); box-shadow: var(--cx-shadow-1); padding: 10px 12px; font-size: 13px; }',
  '.cxb-flow-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }',
  '.cxb-flow-title { font-weight: 600; font-size: 12px; letter-spacing: .3px; text-transform: uppercase; color: var(--cx-ui-text-muted); }',
  '.cxb-flow-close { border: none; background: none; color: var(--cx-ui-text-muted); font-size: 16px; cursor: pointer; padding: 0 2px; }',
  '.cxb-flow-node { padding: 6px 8px; border: 1px solid var(--cx-ui-border-subtle); border-radius: var(--cx-radius-md); background: var(--cx-ui-surface); }',
  '.cxb-flow-param { font-family: var(--cx-font-mono, monospace); color: var(--cx-ui-accent-strong); }',
  '.cxb-flow-arrow { padding: 2px 0 2px 10px; color: var(--cx-ui-text-muted); font-size: 12px; }',
  '.cxb-flow-sub, .cxb-flow-kind { color: var(--cx-ui-text-muted); font-size: 12px; }',
  '.cxb-flow-link { display: block; border: none; background: none; padding: 1px 0; color: var(--cx-ui-text); font: inherit; cursor: pointer; text-align: left; }',
  '.cxb-flow-link:hover { text-decoration: underline; }',
  '.cxb-flow-current { font-weight: 600; cursor: default; }',
  '.cxb-flow-current:hover { text-decoration: none; }',
  '.cxb-flow-sql { margin-left: 6px; border: 1px solid var(--cx-ui-border); background: var(--cx-ui-surface); border-radius: var(--cx-radius-md);',
  '  font-size: 11px; padding: 0 5px; cursor: pointer; color: var(--cx-ui-accent-strong); }',
  '.cxb-flow-sqltext { white-space: pre-wrap; font-size: 12px; background: var(--cx-ui-surface); border: 1px solid var(--cx-ui-border-subtle);',
  '  border-radius: var(--cx-radius-md); padding: 10px; max-height: 50vh; overflow: auto; }',
  '.cxb-flow-sqltext mark { background: var(--cx-ui-accent-strong); color: var(--cx-ui-on-accent); border-radius: var(--cx-radius-sm); padding: 0 2px; }',
  /* live editable cells */
  // Cells clip exactly like the viewer (the hover chrome sits inside the cell).
  '.cxb-cell { position: relative; }',
  '.cxb-cell.cxb-selected { outline: 2px solid var(--cx-ui-accent); outline-offset: -1px; z-index: var(--cx-z-base); }',
  /* The floating panel toolbar and resize handles (z-index 10006+) would show
     through a maximized chart / its customizer: hide them meanwhile. */
  'body.has-fullscreen .cxb-chrome, body.has-fullscreen .cxb-resize { display: none !important; }',
  // A held (dragged) cell floats above everything, semi-transparent: crossing
  // another panel reads as "in motion", and the board underneath stays visible.
  '.cxb-cell.cxb-dragging { opacity: .65; z-index: var(--cx-z-raised); box-shadow: var(--cx-shadow-2); }',
  '.cxb-cell.cxb-drop { outline: 2px dashed var(--cx-ui-accent); outline-offset: -3px; background: var(--cx-ui-accent-tint-subtle); z-index: 2; }',
  /* Dragging a dataset from the data list over the canvas: the whole builder
     area reads as a drop target that will spawn a new panel. */
  '.cxb.cxb-dataset-drop { outline: 2px dashed var(--cx-ui-accent); outline-offset: -4px; background: var(--cx-ui-accent-tint-subtle); border-radius: var(--cx-ui-radius, 6px); }',
  // A touch taller in the builder so the floating edit-chrome pill (~32px) sits
  // fully inside the bar, vertically centred (see .cxb-chrome top below).
  '.cxb-cell .cxd-panel-title { cursor: grab; user-select: none; display: flex; align-items: center; gap: 6px; min-height: 44px; box-sizing: border-box; }',
  '.cxb-tools { margin-left: auto; display: inline-flex; gap: 2px; }',
  /* floating chrome (drag grip + tools) for panels without a title bar */
  // Editing controls float over the panel's top-right corner on hover — kept
  // ABOVE CanvasXpress's own hover toolbar (z-index ~10001), so the builder's
  // grip/delete stay clickable on title-less panels —
  // INSIDE the cell so the stage needs no reserved strip above the top row
  // (the builder stage starts exactly where the rendered dashboard does).
  '.cxb-chrome { position: absolute; top: 6px; right: 4px; z-index: calc(var(--cx-z-popover-high) + 4); display: inline-flex;',
  '  align-items: center; gap: 1px; padding: 2px 4px; pointer-events: none; opacity: 0;',
  '  transition: opacity .12s ease; background: var(--cxd-panel-bg);',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); box-shadow: var(--cx-shadow-1); }',
  '.cxb-cell:hover .cxb-chrome, .cxb-cell.cxb-selected .cxb-chrome { opacity: 1; pointer-events: auto; }',
  // The edit chrome is controls, not content: a drag that starts near it must never
  // sweep a text selection across its glyphs (or the resize handle).
  '.cxb-chrome, .cxb-chrome *, .cxb-resize, .cxb-resize * { -webkit-user-select: none; user-select: none; }',
  // Flex-centre the glyphs: line-height alone leaves text glyphs (⚙ ✕ ⠿) sitting
  // low in the box, so the whole pill reads as bottom-heavy even when centred.
  '.cxb-grip { cursor: grab; user-select: none; width: 22px; height: 22px;',
  '  display: inline-flex; align-items: center; justify-content: center; color: var(--cxd-muted); }',
  '.cxb-grip:hover { color: inherit; }',
  '.cxb-chrome .cxb-tools { margin: 0; background: none; box-shadow: none; align-items: center; }',
  '.cxb-tool { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center;',
  '  border-radius: var(--cx-radius-md); cursor: pointer; font-size: 19px; line-height: 1; color: var(--cxd-muted); }',
  '.cxb-tool:hover { background: var(--cx-ui-accent-tint); color: inherit; }',
  '.cxb-tool.cxb-tool-code { width: auto; padding: 0 5px; font: 600 12px/26px var(--cx-font-mono); }',
  /* Corner resize handle: two nested chevrons at 45° (stroked SVG, set in builder.js). Shown
     while the panel is hovered or selected; muted at rest, accent when the handle itself is hovered. */
  '.cxb-resize { position: absolute; right: 2px; bottom: 2px; width: 24px; height: 24px; cursor: nwse-resize; touch-action: none;',
  '  display: flex; align-items: center; justify-content: center; color: var(--cx-ui-text); z-index: var(--cx-z-popover-high);',
  // A soft backing chip keeps the arrow legible over the chart's own bottom-right watermark.
  '  background: color-mix(in srgb, var(--cx-ui-surface) 88%, transparent); border-radius: var(--cx-radius-md);',
  '  opacity: 0; transition: opacity .12s ease, color .12s ease; }',
  '.cxb-resize svg { width: 18px; height: 18px; display: block; }',
  '.cxb-resize:hover { color: var(--cx-ui-accent); }',
  '.cxb-cell:hover .cxb-resize, .cxb-cell.cxb-selected .cxb-resize { opacity: 1; }',
  /* control (table/filter) height-resize: a grabbable bottom edge */
  '.cxb-ctl-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; cursor: ns-resize;',
  '  z-index: var(--cx-z-popover-high); opacity: 0; transition: opacity .12s ease;',
  '  background: linear-gradient(to bottom, transparent, var(--cx-ui-accent-tint)); }',
  '.cxb-cell:hover .cxb-ctl-resize { opacity: 1; }',
  '.cxb-msg { font-size:16px; color: var(--cxd-muted); min-height: 18px; }',
  '.cxb-check { display: inline-flex; align-items: center; gap: 4px; font-size:16px; color: var(--cxd-muted); cursor: pointer; white-space: nowrap; }',
  '.cxb-editable { outline: none; cursor: text; }',
  '.cxb-editable:focus { box-shadow: inset 0 0 0 2px var(--cx-ui-accent-tint); border-radius: var(--cx-radius-sm); }',
  // Text format controls: a segmented-control pill of equal-height items.
  '.cxb-fmt { display: inline-flex; align-items: center; gap: 2px; padding: 3px;',
  '  background: var(--cxd-title-bg); border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-lg); }',
  '.cxb-fmt > * { height: 30px; box-sizing: border-box; vertical-align: middle; margin: 0;',
  '  border: 1px solid transparent; border-radius: var(--cx-radius-md); font: inherit; background: transparent;',
  '  color: var(--cxd-title); transition: background .1s ease, border-color .1s ease; }',
  '.cxb-fmtbtn { width: 28px; display: inline-flex; align-items: flex-end; justify-content: center;',
  '  padding-bottom: 5px; line-height: 1; cursor: pointer; user-select: none; }',
  '.cxb-fmtbtn:hover { background: var(--cx-ui-accent-tint); }',
  '.cxb-fmtbtn:active { background: var(--cx-ui-accent-tint); border-color: var(--cx-ui-accent); }',
  // Font grow/shrink: an "A" with a chevron (MS Word style).
  '.cxb-fmtsizebtn { width: auto; padding: 0 5px 5px; align-items: flex-end; gap: 1px; }',
  '.cxb-fmtsizeA { font-weight: 700; font-size: 16px; line-height: 1; }',
  '.cxb-fmtsizeA-small { font-size: 11px; }',
  '.cxb-fmtsizechev { display: inline-flex; line-height: 0; color: var(--cxd-muted); }',
  // Labelled colour controls: an icon (A = text, ■ = fill) over a bar showing
  // the current colour, with the native picker overlaid transparently.
  '.cxb-colorctl { position: relative; width: 28px; display: inline-flex; flex-direction: column;',
  '  align-items: center; justify-content: center; cursor: pointer; }',
  '.cxb-colorctl:hover { background: var(--cx-ui-accent-tint); }',
  '.cxb-colorctl-ic { display: flex; align-items: center; justify-content: center; line-height: 0;',
  '  color: var(--cxd-title); }',
  '.cxb-colorctl-bar { width: 16px; height: 3px; border-radius: 1px; margin-top: 1px;',
  '  box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }',
  '.cxb-colorctl-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0;',
  '  cursor: pointer; border: none; padding: 0; }',
  /* Add-data modal */
  '.cxb-modal-overlay { position: fixed; inset: 0; background: var(--cx-ui-backdrop); z-index: var(--cx-z-modal);',
  '  display: flex; align-items: center; justify-content: center; padding: 20px; }',
  // Explicit text color: the card is light even when the page/OS is dark, so
  // inheriting the page's light text would render near-invisible headings.
  '.cxb-modal { width: 100%; max-width: 460px; background: var(--cx-ui-surface-raised); color: var(--cx-ui-text);',
  '  border-radius: var(--cx-radius-lg); box-shadow: var(--cx-shadow-3); padding: 18px 18px 14px;',
  '  display: flex; flex-direction: column; gap: 12px; font-family: var(--cxd-font); }',
  '.cxb-modal-title { margin: 0; font-size: 17px; }',
  // Floating variant (e.g. the data/function dialog): a transparent,',
  // click-through overlay so the chart stays visible, and the title is a drag',
  // handle so the dialog can be moved aside.',
  '.cxb-modal-overlay.cxb-modal-float { background: transparent; pointer-events: none; }',
  '.cxb-modal-overlay.cxb-modal-float .cxb-modal { pointer-events: auto; }',
  '.cxb-modal-float .cxb-modal-title { cursor: move; }',
  '.cxb-modal-field { display: flex; flex-direction: column; gap: 4px; }',
  '.cxb-modal-field label { font: 600 14px var(--cxd-font); text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted); }',
  // Checkboxes and radios are the shared CanvasXpress control (.cX-UI-Controls), not text fields
  '.cxb-modal input:not(:where([type=checkbox], [type=radio])), .cxb-modal select, .cxb-modal textarea { width: 100%; box-sizing: border-box;',
  '  padding: 7px 9px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); font: inherit;',
  '  background: var(--cxd-panel-bg); color: inherit; }',
  '.cxb-modal-json { font-family: var(--cx-font-mono); font-size:14px; min-height: 130px; resize: vertical; }',
  // (Dialog dropdowns get the shared chevron rule above.)
  '.cxb-save-note { font-size: 13px; color: var(--cxd-muted); margin-top: -6px; }',
  '.cxb-modal-err { color: var(--cxd-error); font-size:14px; min-height: 17px; }',
  // Save / Save-a-copy dialog: name + access (private, everyone, specific people).
  '.cxb-save-intro { font-size: 14px; line-height: 1.45; color: var(--cxd-muted); }',
  '.cxb-save-people { display: flex; flex-direction: column; gap: 6px; }',
  // The generic `.cxb-modal select { width: 100% }` would make both selects
  // claim the whole row (collapsing the first, pushing Add out): size them here.
  '.cxb-modal .cxb-save-pick { display: flex; gap: 6px; align-items: center; width: 100%; }',
  '.cxb-modal .cxb-save-pick select { width: auto; min-width: 0; }',
  '.cxb-modal .cxb-save-pick .cxb-save-who { flex: 1 1 0; }',
  '.cxb-modal .cxb-save-pick .cxb-save-level { flex: 0 0 112px; }',
  '.cxb-modal .cxb-save-pick .cxb-btn { flex: 0 0 auto; }',
  '.cxb-save-chips { display: flex; flex-wrap: wrap; gap: 6px; }',
  '.cxb-save-chip { display: inline-flex; align-items: center; gap: 2px; padding: 2px 4px 2px 10px; border-radius: var(--cx-radius-pill);',
  '  background: var(--cx-ui-accent-tint-subtle); color: var(--cx-ui-accent-strong); font-size: 13px; }',
  '.cxb-save-chip-x { border: none; background: none; color: inherit; font-size: 15px; line-height: 1; cursor: pointer; padding: 0 4px; }',
  '.cxb-save-none { font-size: 13px; color: var(--cxd-muted); }',
  /* Whole-spec JSON editor (✎ next to the dashboard title): a line-number
     gutter + a highlight.js-style colorized layer under a transparent-text
     textarea that owns editing and scrolling. */
  '.cxb-modal-wide { max-width: 780px; }',
  // "+ Panel": fields left, live preview right (stacked on narrow screens).
  '.cxb-modal-xl { max-width: 1120px; }',
  '.cxb-panel-cols { display: flex; gap: 18px; align-items: flex-start; }',
  '.cxb-panel-fields { flex: 0 0 300px; min-width: 0; }',
  '.cxb-panel-right { flex: 1 1 auto; min-width: 0; }',
  '.cxb-panel-preview { min-height: 400px; }',
  '@media (max-width: 800px) { .cxb-panel-cols { flex-direction: column; } .cxb-panel-fields { flex-basis: auto; width: 100%; } }',
  '.cxb-jsoned { display: flex; height: 55vh; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); overflow: hidden; background: var(--cxd-panel-bg); }',
  '.cxb-jsoned, .cxb-jsoned-gutter, .cxb-jsoned-hl, .cxb-jsoned-hl code, .cxb-jsoned-ta {',
  '  font: 13px/1.5 var(--cx-font-mono); }',
  '.cxb-jsoned-gutter { flex: 0 0 auto; min-width: 44px; padding: 8px 8px 8px 4px; text-align: right;',
  '  color: var(--cxd-muted); background: var(--cx-ui-surface-sunken); border-right: 1px solid var(--cx-ui-divider);',
  '  overflow: hidden; white-space: pre; user-select: none; }',
  '.cxb-jsoned-body { position: relative; flex: 1 1 auto; min-width: 0; }',
  '.cxb-jsoned-hl { position: absolute; inset: 0; margin: 0; padding: 8px 10px; overflow: hidden;',
  '  white-space: pre; color: var(--cxd-title); pointer-events: none; }',
  // !important beats the generic `.cxb-modal textarea { color: inherit; background: … }`
  // rule (higher specificity), which otherwise paints the textarea text opaque
  // ON TOP of the colorized layer — leaving the editor looking uncolored.
  '.cxb-jsoned-ta { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box;',
  '  padding: 8px 10px !important; margin: 0; border: none !important; outline: none; resize: none;',
  '  overflow: auto; white-space: pre; background: transparent !important; color: transparent !important;',
  '  font: 13px/1.5 var(--cx-font-mono) !important;',
  '  border-radius: 0; caret-color: var(--cx-ui-text); }',
  // Vivid token palette. The modal is always light (it lives outside the
  // themed container), so the editor is explicitly light too — theme-tracking
  // token colors here just wash out on the white card in OS dark mode.
  '.cxb-jsoned { background: var(--cx-ui-surface); border-color: var(--cx-ui-border); }',
  '.cxb-jsoned-hl { color: var(--cx-ui-text); }',
  '.cxb-jsoned-ta { caret-color: var(--cx-ui-text); }',
  '.cxb-jsoned-gutter { color: var(--cx-ui-text-subtle); background: var(--cx-ui-surface-sunken); border-color: var(--cx-ui-divider); }',
  // Error-line marker: the line a failed Save points at (parse position or
  // offending key), cleared as soon as the user edits again.
  '.cxb-hl-errline { background: var(--cx-ui-danger-tint); box-shadow: inset 3px 0 0 var(--cx-ui-danger); }',
  '.cxb-jsoned-gutter-err { color: var(--cx-ui-danger); font-weight: 700; }',
  '.cxb-hl-attr { color: #0969da; font-weight: 600; }',       // property names: blue
  '.cxb-hl-string { color: #188038; }',                       // string values: green
  '.cxb-hl-number { color: #e36209; }',                       // numbers: orange
  '.cxb-hl-literal { color: #cf222e; font-weight: 600; }',    // true/false/null: red
  '.cxb-modal-footer { display: flex; justify-content: flex-end; gap: 8px; }',
  // Links dialog: the declared links (one row each, with a remove ×) and the
  // source + key pickers. Selects are sized explicitly, as in the Save dialog.
  '.cxb-links-intro { font-size: 14px; line-height: 1.45; color: var(--cxd-muted); margin: 0; }',
  '.cxb-links-list { display: flex; flex-direction: column; gap: 6px; }',
  '.cxb-links-row { display: flex; align-items: center; gap: 8px; padding: 6px 4px 6px 10px; border-radius: var(--cx-radius-md);',
  '  background: var(--cx-ui-surface-sunken); font-size: 14px; }',
  '.cxb-links-row span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }',
  '.cxb-links-none { font-size: 13px; color: var(--cxd-muted); }',
  // Only the steps scroll, so the title and Apply stay on screen however many steps a tour has.
  '.cxb-story-list { max-height: 38vh; overflow-y: auto; }',
  '.cxb-story-row { align-items: flex-start; }',
  '.cxb-story-row > span { display: flex; flex-direction: column; gap: 4px; }',
  '.cxb-story-row input, .cxb-story-row textarea { width: 100%; box-sizing: border-box; font: inherit; }',
  '.cxb-modal .cxb-links-pick { display: flex; gap: 6px; align-items: center; width: 100%; }',
  // Selects keep a readable width next to a text box (which takes the rest).
  '.cxb-modal .cxb-links-pick select { width: auto; min-width: 120px; flex: 1 1 0; }',
  '.cxb-modal .cxb-links-pick input[type=text], .cxb-modal .cxb-links-pick input[type=number] { flex: 1 1 0; min-width: 0; width: auto; }',
  // A checkbox inside a field reads as an option, not as another field label.
  '.cxb-modal-field label.cxb-check, .cxb-modal .cxb-links-pick label.cxb-check { text-transform: none; font-weight: 400;',
  '  letter-spacing: normal; font-size: 14px; color: inherit; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }',
  '.cxb-modal .cxb-modal-fn-inputs { display: flex; flex-wrap: wrap; gap: 4px 14px; }'
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
