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
  '.cxd-code-backdrop { position: fixed; inset: 0; z-index: var(--cx-z-modal); display: flex; align-items: center; justify-content: center;',
  '  padding: 16px; background: var(--cx-ui-backdrop); }',
  '.cxd-code-dialog { display: flex; flex-direction: column; width: min(760px, 100%); max-height: min(85vh, 900px);',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-lg); background: var(--cxd-panel-bg);',
  '  color: var(--cxd-title); box-shadow: var(--cx-shadow-3); font: 14px/1.45 var(--cxd-font); }',
  '.cxd-code-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--cxd-border); }',
  '.cxd-code-heading { flex: 1 1 auto; min-width: 0; font-weight: 600; font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
  '.cxd-code-close { border: none; background: none; color: var(--cxd-muted); font-size: 22px; line-height: 1; cursor: pointer; }',
  '.cxd-code-body { overflow: auto; padding: 6px 14px 14px; }',
  '.cxd-code-step { padding-top: 10px; }',
  '.cxd-code-step-title { font-weight: 600; }',
  '.cxd-code-step-detail { color: var(--cxd-muted); font-size: 13px; margin-top: 2px; }',
  '.cxd-code-block { position: relative; margin-top: 6px; }',
  '.cxd-code-block pre { margin: 0; padding: 10px 12px; overflow: auto; max-height: 340px; border-radius: var(--cx-radius-md);',
  '  border: 1px solid var(--cxd-border); background: var(--cxd-title-bg);',
  '  font: 12.5px/1.5 var(--cx-font-mono); white-space: pre; tab-size: 2; }',
  '.cxd-code-copy { position: absolute; top: 6px; right: 6px; padding: 1px 8px; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); background: var(--cxd-panel-bg); color: var(--cxd-muted); font-size: 12px; cursor: pointer; }',
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
  '.cxd-annctl-search { min-width: 140px; }',
  // Controls use --cxd-ctrl-border (a colour the renderer computes to contrast
  // with whatever the control sits on) so the box stays visible even when the
  // panel chrome is coordinated to the background. Falls back to the theme border.
  '.cxd-annctl-select { padding: 4px 7px; border: 1px solid var(--cxd-ctrl-border, var(--cxd-border)); border-radius: var(--cx-radius-md);',
  '  font: inherit; background: var(--cxd-panel-bg); color: inherit; }',
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
  '.cxb-topbar { display: flex; flex-direction: column; align-items: stretch; gap: 12px; width: 100%; }',
  '.cxb-trow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
  '.cxb-tgroup { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '.cxb-spacer { flex: 1 1 auto; }',
  '.cxb-tlabel { font: 600 14px var(--cxd-font); text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted); }',
  '.cxb-title-input { padding: 5px 8px; border: 1px solid var(--cxd-border);',
  '  border-radius: var(--cx-radius-md); font: 600 16px var(--cxd-font); min-width: 150px; }',
  '.cxb-tinput { padding: 5px 8px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md);',
  '  font: inherit; width: 130px; }',
  '.cxb-props { min-height: 34px; }',
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
  // Toolbar inputs on the roles (dark follows the page's data-cx-ui-theme, not the OS)
  '.cxb-title-input, .cxb-tinput, .cxb-props select { background: var(--cx-ui-surface); color: var(--cx-ui-text); }',
  '.cxb-stage { width: 100%; min-width: 0; }',
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
  '.cxb-cell .cxd-panel-title { cursor: grab; user-select: none; display: flex; align-items: center; gap: 6px; }',
  '.cxb-tools { margin-left: auto; display: inline-flex; gap: 2px; }',
  /* floating chrome (drag grip + tools) for panels without a title bar */
  // Editing controls float over the panel's top-right corner on hover — kept
  // ABOVE CanvasXpress's own hover toolbar (z-index ~10001), so the builder's
  // grip/delete stay clickable on title-less panels —
  // INSIDE the cell so the stage needs no reserved strip above the top row
  // (the builder stage starts exactly where the rendered dashboard does).
  '.cxb-chrome { position: absolute; top: 4px; right: 4px; z-index: calc(var(--cx-z-popover-high) + 4); display: inline-flex;',
  '  align-items: center; gap: 1px; padding: 2px 4px; pointer-events: none; opacity: 0;',
  '  transition: opacity .12s ease; background: var(--cxd-panel-bg);',
  '  border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); box-shadow: var(--cx-shadow-1); }',
  '.cxb-cell:hover .cxb-chrome, .cxb-cell.cxb-selected .cxb-chrome { opacity: 1; pointer-events: auto; }',
  '.cxb-grip { cursor: grab; user-select: none; width: 22px; height: 22px; line-height: 22px;',
  '  text-align: center; color: var(--cxd-muted); }',
  '.cxb-grip:hover { color: inherit; }',
  '.cxb-chrome .cxb-tools { margin: 0; background: none; box-shadow: none; }',
  '.cxb-tool { width: 26px; height: 26px; line-height: 24px; text-align: center; border-radius: var(--cx-radius-md);',
  '  cursor: pointer; font-size: 19px; color: var(--cxd-muted); }',
  '.cxb-tool:hover { background: var(--cx-ui-accent-tint); color: inherit; }',
  '.cxb-tool.cxb-tool-code { width: auto; padding: 0 5px; font: 600 12px/26px var(--cx-font-mono); }',
  '.cxb-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;',
  '  background: linear-gradient(135deg, transparent 50%, var(--cx-ui-accent) 50%); border-bottom-right-radius: var(--cx-radius-lg); z-index: var(--cx-z-popover-high);',
  '  opacity: 0; transition: opacity .12s ease; }',
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
  '.cxb-modal-field { display: flex; flex-direction: column; gap: 4px; }',
  '.cxb-modal-field label { font: 600 14px var(--cxd-font); text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted); }',
  // Checkboxes and radios are the shared CanvasXpress control (.cX-UI-Controls), not text fields
  '.cxb-modal input:not(:where([type=checkbox], [type=radio])), .cxb-modal select, .cxb-modal textarea { width: 100%; box-sizing: border-box;',
  '  padding: 7px 9px; border: 1px solid var(--cxd-border); border-radius: var(--cx-radius-md); font: inherit;',
  '  background: var(--cxd-panel-bg); color: inherit; }',
  '.cxb-modal-json { font-family: var(--cx-font-mono); font-size:14px; min-height: 130px; resize: vertical; }',
  /* Dialog dropdowns: our own chevron, inset from the right border (the native
     arrow sits almost on it). The dialog card is always light. */
  '.cxb-modal select { -webkit-appearance: none; -moz-appearance: none; appearance: none; padding-right: 32px;',
  '  background-image: url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 12 8%22%3E%3Cpath d=%22M1 1.5l5 5 5-5%22 fill=%22none%22 stroke=%22%2357606a%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/%3E%3C/svg%3E");',
  '  background-repeat: no-repeat; background-position: right 11px center; background-size: 12px 8px; cursor: pointer; }',
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
