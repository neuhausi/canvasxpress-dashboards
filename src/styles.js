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
  '.cxd-panel-title { flex: 0 0 auto; padding: 6px 10px; font: 600 16px/1.3 var(--cxd-font, system-ui, sans-serif);',
  '  color: var(--cxd-title, #2a2f36); border-bottom: 1px solid var(--cxd-border, #e2e5ea);',
  '  background: var(--cxd-title-bg, #f7f8fa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
  // Centre the graph canvas in the body so any leftover space (the few px a
  // graph leaves, or a reserved canvasInset margin) is even on ALL sides rather
  // than pooling at the right and bottom. Text/control panels set their own
  // inline flex alignment (applyAlignment), which overrides this.
  '.cxd-panel-body { position: relative; flex: 1 1 auto; min-height: 0;',
  '  display: flex; align-items: center; justify-content: center; }',
  '.cxd-text { width: 100%; height: 100%; padding: 5px 12px; overflow: auto;',
  '  font: 16px/1.35 system-ui, sans-serif; color: var(--cxd-title, #2a2f36); white-space: pre-wrap; word-break: break-word; }',
  // Text elements are chrome-free by default (no border/background) so they sit
  // on the dashboard background; an explicit panel.bg fills the cell instead.
  '.cxd-text-cell { border: none; background: transparent; z-index: 2; }',
  // Image elements: the picture fills the cell and scales via object-fit; the
  // cell is chrome-free like text. It resizes with the cell (its grid span).
  '.cxd-image-cell { border: none; background: transparent; z-index: 2; overflow: hidden; }',
  '.cxd-image { display: block; width: 100%; height: 100%; object-fit: contain; }',
  '.cxd-image-link { display: block; width: 100%; height: 100%; }',
  '.cxd-image-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;',
  '  padding: 8px; text-align: center; box-sizing: border-box; color: var(--cxd-muted, #8a9099);',
  '  font: 13px/1.4 system-ui, sans-serif; border: 1px dashed var(--cxd-border, #d0d4da); border-radius: 8px; }',
  // Annotation-filter controls float free like text: a chrome-less cell holding
  // a compact pill widget, so it reads cleanly when overlapping a graph.
  // Free-floating cells (text/control) stack ABOVE solid panels (z-index) —
  // collision resolution lets graphs compact through their rows, and without
  // the raise a control ends up hidden behind whichever panel slid over it.
  '.cxd-annctl-cell { border: none; background: transparent; overflow: visible; z-index: 3; }',
  // Filters panel: a titled panel whose body scrolls a stack of field sections.
  '.cxd-filters-cell .cxd-panel-body { align-items: stretch; justify-content: flex-start; overflow: auto; }',
  '.cxd-filters { width: 100%; padding: 8px 10px; font: 13px/1.35 var(--cxd-font, system-ui, sans-serif); color: var(--cxd-title, #2a2f36); }',
  '.cxd-filters-bar { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }',
  '.cxd-filters-bar select, .cxd-filters-bar input, .cxd-filters-bar button, .cxd-filters-range input, .cxd-filters-text {',
  '  padding: 3px 6px; border: 1px solid var(--cxd-ctrl-border,var(--cxd-border,#d0d4da)); border-radius: 6px;',
  '  font: inherit; background: var(--cxd-ctrl-bg,#fff); color: inherit; }',
  '.cxd-filters-scheme-name { width: 110px; }',
  '.cxd-filters-bar button { cursor: pointer; }',
  '.cxd-filters-field { padding: 6px 0; border-top: 1px solid var(--cxd-border, #e2e5ea); }',
  '.cxd-filters-label { font-weight: 600; margin-bottom: 4px; }',
  '.cxd-filters-values { display: flex; flex-direction: column; gap: 2px; max-height: 160px; overflow: auto; }',
  '.cxd-filters-check { display: flex; align-items: center; gap: 6px; cursor: pointer; }',
  '.cxd-filters-range { display: flex; align-items: center; gap: 6px; }',
  '.cxd-filters-range input { width: 0; flex: 1 1 0; min-width: 60px; }',
  '.cxd-filters-text { width: 100%; }',
  '.cxd-filters-hint { color: var(--cxd-muted,#8a9099); }',
  '.cxd-annctl { display: inline-flex; align-items: center; gap: 8px; flex-wrap: wrap; max-width: 100%;',
  '  padding: 5px 0; background: transparent;',
  '  font: 14px/1.3 var(--cxd-font, system-ui, sans-serif); color: var(--cxd-title,#2a2f36); }',
  '.cxd-annctl-label { font-weight: 600; white-space: nowrap; }',
  '.cxd-annctl-hint { color: var(--cxd-muted,#8a9099); }',
  '.cxd-annctl-disabled { opacity: 0.65; }',
  '.cxd-annctl-search { min-width: 140px; }',
  // Controls use --cxd-ctrl-border (a colour the renderer computes to contrast
  // with whatever the control sits on) so the box stays visible even when the
  // panel chrome is coordinated to the background. Falls back to the theme border.
  '.cxd-annctl-select { padding: 4px 7px; border: 1px solid var(--cxd-ctrl-border,var(--cxd-border,#d0d4da)); border-radius: 6px;',
  '  font: inherit; background: var(--cxd-panel-bg,#fff); color: inherit; }',
  '.cxd-annctl-radios { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
  '.cxd-annctl-radio { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }',
  '.cxd-annctl-seg { display: inline-flex; border: 1px solid var(--cxd-ctrl-border,var(--cxd-border,#d0d4da)); border-radius: 6px; overflow: hidden; }',
  '.cxd-annctl-segbtn { padding: 4px 11px; border: none; border-right: 1px solid var(--cxd-ctrl-border,var(--cxd-border,#d0d4da));',
  '  background: transparent; color: inherit; font: inherit; cursor: pointer; white-space: nowrap; }',
  '.cxd-annctl-segbtn:last-child { border-right: none; }',
  '.cxd-annctl-segbtn:hover { background: rgba(0,0,0,.06); }',
  '.cxd-annctl-segbtn.cxd-annctl-on { background: #2f6feb; color: #fff; }',
  /* config-control slider. canvasXpress.css (15-range-slider.css) styles EVERY
     input[type=range] absolute/invisible with a red-square thumb for its
     dual-thumb widget — and its `input[type=range]::...` selectors outrank a bare
     `.cxd-slider::...`. Qualify ours with input[type=range] to win the cascade
     and force the slider visible + interactive. */
  'input[type=range].cxd-slider { position: static !important; pointer-events: auto !important; opacity: 1 !important;',
  '  -webkit-appearance: none; appearance: none; width: 220px; max-width: 46vw; height: 20px;',
  '  background: transparent; cursor: pointer; vertical-align: middle; z-index: auto; }',
  'input[type=range].cxd-slider::-webkit-slider-runnable-track { height: 5px; border-radius: 3px; background: var(--cxd-ctrl-border,#cfd6e4); }',
  'input[type=range].cxd-slider::-moz-range-track { height: 5px; border-radius: 3px; background: var(--cxd-ctrl-border,#cfd6e4); }',
  'input[type=range].cxd-slider::-webkit-slider-thumb { pointer-events: all; -webkit-appearance: none; appearance: none; margin-top: -6px;',
  '  width: 16px; height: 16px; border-radius: 50%; background: #2f6feb; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); }',
  'input[type=range].cxd-slider::-moz-range-thumb { width: 16px; height: 16px; border-radius: 50%; background: #2f6feb; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.35); }',
  '.cxd-slider-readout { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 120px; white-space: nowrap; }',
  /* when panels reserve a canvas margin, centre the (smaller) graph in the cell */
  '.cxd-inset .cxd-panel-body { display: flex; align-items: center; justify-content: center; }',
  '.cxd-canvas { display: block; width: 100%; height: 100%; }',
  '.cxd-panel-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;',
  '  font: 500 16px system-ui, sans-serif; color: var(--cxd-muted, #8a9099);',
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
  // Two fixed rows: create actions + Save, then the selected element's
  // configuration (always reserved, so the stage never jumps on select).
  '.cxb-topbar { display: flex; flex-direction: column; align-items: stretch; gap: 12px; width: 100%; }',
  '.cxb-trow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }',
  '.cxb-tgroup { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }',
  '.cxb-spacer { flex: 1 1 auto; }',
  '.cxb-tlabel { font: 600 14px system-ui; text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted,#8a9099); }',
  '.cxb-title-input { padding: 5px 8px; border: 1px solid var(--cxd-border,#e2e5ea);',
  '  border-radius: 6px; font: 600 16px system-ui; min-width: 150px; }',
  '.cxb-tinput { padding: 5px 8px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px;',
  '  font: inherit; width: 130px; }',
  '.cxb-props { min-height: 34px; }',
  '.cxb-props select { padding: 5px 5px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px; font: inherit; }',
  // Compact labels in the props row so a control's full configuration fits on
  // one line in a ~1400px window.
  '.cxb-props .cxb-tlabel { font-size: 12px; }',
  /* Toolbar controls set explicit colours (they render into the host app shell,
     which may be dark) — `color: inherit` here would pick up light shell text on
     the light button and vanish. Dark-scheme overrides are below. */
  '.cxb-btn { padding: 6px 13px; border: 1px solid #d0d4da; border-radius: 6px;',
  '  background: #f7f8fa; color: #2a2f36; font: 500 16px system-ui; cursor: pointer; }',
  '.cxb-btn:hover { background: #eceef1; }',
  '.cxb-btn:disabled { opacity: 0.45; cursor: not-allowed; }',
  '.cxb-btn:disabled:hover { background: inherit; }',
  '.cxb-btn-primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }',
  '.cxb-btn-primary:hover { background: #295fd0; }',
  '@media (prefers-color-scheme: dark) {',
  '  .cxb-btn { background: #1d2027; color: #e6e8ec; border-color: #2c313a; }',
  '  .cxb-btn:hover { background: #2c313a; }',
  '  .cxb-title-input, .cxb-tinput, .cxb-props select { background: #16181d; color: #e6e8ec; border-color: #2c313a; } }',
  '.cxb-stage { width: 100%; min-width: 0; }',
  /* live editable cells */
  // Cells clip exactly like the viewer (the hover chrome sits inside the cell).
  '.cxb-cell { position: relative; }',
  '.cxb-cell.cxb-selected { outline: 2px solid #2f6feb; outline-offset: -1px; z-index: 1; }',
  // A held (dragged) cell floats above everything, semi-transparent: crossing
  // another panel reads as "in motion", and the board underneath stays visible.
  '.cxb-cell.cxb-dragging { opacity: .65; z-index: 10; box-shadow: 0 8px 24px rgba(0,0,0,.25); }',
  '.cxb-cell.cxb-drop { outline: 2px dashed #2f6feb; outline-offset: -3px; background: rgba(47,111,235,0.06); z-index: 2; }',
  '.cxb-cell .cxd-panel-title { cursor: grab; user-select: none; display: flex; align-items: center; gap: 6px; }',
  '.cxb-tools { margin-left: auto; display: inline-flex; gap: 2px; }',
  /* floating chrome (drag grip + tools) for panels without a title bar */
  // Editing controls float over the panel's top-right corner on hover — kept
  // ABOVE CanvasXpress's own hover toolbar (z-index ~10001), so the builder's
  // grip/delete stay clickable on title-less panels —
  // INSIDE the cell so the stage needs no reserved strip above the top row
  // (the builder stage starts exactly where the rendered dashboard does).
  '.cxb-chrome { position: absolute; top: 4px; right: 4px; z-index: 10010; display: inline-flex;',
  '  align-items: center; gap: 1px; padding: 2px 4px; pointer-events: none; opacity: 0;',
  '  transition: opacity .12s ease; background: var(--cxd-panel-bg,#fff);',
  '  border: 1px solid var(--cxd-border,#e2e5ea); border-radius: 6px; box-shadow: 0 1px 4px rgba(0,0,0,.18); }',
  '.cxb-cell:hover .cxb-chrome, .cxb-cell.cxb-selected .cxb-chrome { opacity: 1; pointer-events: auto; }',
  '.cxb-grip { cursor: grab; user-select: none; width: 22px; height: 22px; line-height: 22px;',
  '  text-align: center; color: var(--cxd-muted,#6b7280); }',
  '.cxb-grip:hover { color: inherit; }',
  '.cxb-chrome .cxb-tools { margin: 0; background: none; box-shadow: none; }',
  '.cxb-tool { width: 26px; height: 26px; line-height: 24px; text-align: center; border-radius: 5px;',
  '  cursor: pointer; font-size: 19px; color: var(--cxd-muted,#6b7280); }',
  '.cxb-tool:hover { background: rgba(0,0,0,.08); color: inherit; }',
  '.cxb-resize { position: absolute; right: 0; bottom: 0; width: 14px; height: 14px; cursor: nwse-resize;',
  '  background: linear-gradient(135deg, transparent 50%, #2f6feb 50%); border-bottom-right-radius: 8px; z-index: 10006;',
  '  opacity: 0; transition: opacity .12s ease; }',
  '.cxb-cell:hover .cxb-resize, .cxb-cell.cxb-selected .cxb-resize { opacity: 1; }',
  /* control (table/filter) height-resize: a grabbable bottom edge */
  '.cxb-ctl-resize { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; cursor: ns-resize;',
  '  z-index: 10006; opacity: 0; transition: opacity .12s ease;',
  '  background: linear-gradient(to bottom, transparent, rgba(47,111,235,.55)); }',
  '.cxb-cell:hover .cxb-ctl-resize { opacity: 1; }',
  '.cxb-msg { font-size:16px; color: var(--cxd-muted,#8a9099); min-height: 18px; }',
  '.cxb-check { display: inline-flex; align-items: center; gap: 4px; font-size:16px; color: var(--cxd-muted,#6b7280); cursor: pointer; white-space: nowrap; }',
  '.cxb-editable { outline: none; cursor: text; }',
  '.cxb-editable:focus { box-shadow: inset 0 0 0 2px rgba(47,111,235,.35); border-radius: 4px; }',
  // Text format controls: a segmented-control pill of equal-height items.
  '.cxb-fmt { display: inline-flex; align-items: center; gap: 2px; padding: 3px;',
  '  background: var(--cxd-title-bg,#f4f6f8); border: 1px solid var(--cxd-border,#e2e5ea); border-radius: 8px; }',
  '.cxb-fmt > * { height: 30px; box-sizing: border-box; vertical-align: middle; margin: 0;',
  '  border: 1px solid transparent; border-radius: 5px; font: inherit; background: transparent;',
  '  color: var(--cxd-title,#2a2f36); transition: background .1s ease, border-color .1s ease; }',
  '.cxb-fmtbtn { width: 28px; display: inline-flex; align-items: flex-end; justify-content: center;',
  '  padding-bottom: 5px; line-height: 1; cursor: pointer; user-select: none; }',
  '.cxb-fmtbtn:hover { background: rgba(0,0,0,.06); }',
  '.cxb-fmtbtn:active { background: rgba(47,111,235,.16); border-color: rgba(47,111,235,.35); }',
  // Font grow/shrink: an "A" with a chevron (MS Word style).
  '.cxb-fmtsizebtn { width: auto; padding: 0 5px 5px; align-items: flex-end; gap: 1px; }',
  '.cxb-fmtsizeA { font-weight: 700; font-size: 16px; line-height: 1; }',
  '.cxb-fmtsizeA-small { font-size: 11px; }',
  '.cxb-fmtsizechev { display: inline-flex; line-height: 0; color: var(--cxd-muted,#6b7280); }',
  // Labelled colour controls: an icon (A = text, ■ = fill) over a bar showing
  // the current colour, with the native picker overlaid transparently.
  '.cxb-colorctl { position: relative; width: 28px; display: inline-flex; flex-direction: column;',
  '  align-items: center; justify-content: center; cursor: pointer; }',
  '.cxb-colorctl:hover { background: rgba(0,0,0,.06); }',
  '.cxb-colorctl-ic { display: flex; align-items: center; justify-content: center; line-height: 0;',
  '  color: var(--cxd-title,#2a2f36); }',
  '.cxb-colorctl-bar { width: 16px; height: 3px; border-radius: 1px; margin-top: 1px;',
  '  box-shadow: inset 0 0 0 1px rgba(0,0,0,.15); }',
  '.cxb-colorctl-input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0;',
  '  cursor: pointer; border: none; padding: 0; }',
  /* Add-data modal */
  '.cxb-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 10000;',
  '  display: flex; align-items: center; justify-content: center; padding: 20px; }',
  // Explicit text color: the card is light even when the page/OS is dark, so
  // inheriting the page's light text would render near-invisible headings.
  '.cxb-modal { width: 100%; max-width: 460px; background: #ffffff; color: #24292f;',
  '  border-radius: 10px; box-shadow: 0 10px 40px rgba(0,0,0,.25); padding: 18px 18px 14px;',
  '  display: flex; flex-direction: column; gap: 12px; font-family: system-ui, sans-serif; }',
  '.cxb-modal-title { margin: 0; font-size: 17px; }',
  '.cxb-modal-field { display: flex; flex-direction: column; gap: 4px; }',
  '.cxb-modal-field label { font: 600 14px system-ui; text-transform: uppercase; letter-spacing: .03em;',
  '  color: var(--cxd-muted,#8a9099); }',
  '.cxb-modal input, .cxb-modal select, .cxb-modal textarea { width: 100%; box-sizing: border-box;',
  '  padding: 7px 9px; border: 1px solid var(--cxd-border,#d0d4da); border-radius: 6px; font: inherit;',
  '  background: var(--cxd-panel-bg,#fff); color: inherit; }',
  '.cxb-modal-json { font-family: ui-monospace, Menlo, monospace; font-size:14px; min-height: 130px; resize: vertical; }',
  '.cxb-modal-err { color: var(--cxd-error,#c0392b); font-size:14px; min-height: 17px; }',
  /* Whole-spec JSON editor (✎ next to the dashboard title): a line-number
     gutter + a highlight.js-style colorized layer under a transparent-text
     textarea that owns editing and scrolling. */
  '.cxb-modal-wide { max-width: 780px; }',
  '.cxb-jsoned { display: flex; height: 55vh; border: 1px solid var(--cxd-border,#d0d4da);',
  '  border-radius: 6px; overflow: hidden; background: var(--cxd-panel-bg,#fff); }',
  '.cxb-jsoned, .cxb-jsoned-gutter, .cxb-jsoned-hl, .cxb-jsoned-hl code, .cxb-jsoned-ta {',
  '  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }',
  '.cxb-jsoned-gutter { flex: 0 0 auto; min-width: 44px; padding: 8px 8px 8px 4px; text-align: right;',
  '  color: var(--cxd-muted,#8a9099); background: rgba(0,0,0,.035); border-right: 1px solid var(--cxd-border,#e2e5ea);',
  '  overflow: hidden; white-space: pre; user-select: none; }',
  '.cxb-jsoned-body { position: relative; flex: 1 1 auto; min-width: 0; }',
  '.cxb-jsoned-hl { position: absolute; inset: 0; margin: 0; padding: 8px 10px; overflow: hidden;',
  '  white-space: pre; color: var(--cxd-title,#24292f); pointer-events: none; }',
  // !important beats the generic `.cxb-modal textarea { color: inherit; background: … }`
  // rule (higher specificity), which otherwise paints the textarea text opaque
  // ON TOP of the colorized layer — leaving the editor looking uncolored.
  '.cxb-jsoned-ta { position: absolute; inset: 0; width: 100%; height: 100%; box-sizing: border-box;',
  '  padding: 8px 10px !important; margin: 0; border: none !important; outline: none; resize: none;',
  '  overflow: auto; white-space: pre; background: transparent !important; color: transparent !important;',
  '  font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace !important;',
  '  border-radius: 0; caret-color: #24292f; }',
  // Vivid token palette. The modal is always light (it lives outside the
  // themed container), so the editor is explicitly light too — theme-tracking
  // token colors here just wash out on the white card in OS dark mode.
  '.cxb-jsoned { background: #ffffff; border-color: #d0d4da; }',
  '.cxb-jsoned-hl { color: #24292f; }',
  '.cxb-jsoned-ta { caret-color: #24292f; }',
  '.cxb-jsoned-gutter { color: #8a9099; background: #f2f4f7; border-color: #e2e5ea; }',
  // Error-line marker: the line a failed Save points at (parse position or
  // offending key), cleared as soon as the user edits again.
  '.cxb-hl-errline { background: rgba(207,34,46,.12); box-shadow: inset 3px 0 0 #cf222e; }',
  '.cxb-jsoned-gutter-err { color: #cf222e; font-weight: 700; }',
  '.cxb-hl-attr { color: #0969da; font-weight: 600; }',       // property names: blue
  '.cxb-hl-string { color: #188038; }',                       // string values: green
  '.cxb-hl-number { color: #e36209; }',                       // numbers: orange
  '.cxb-hl-literal { color: #cf222e; font-weight: 600; }',    // true/false/null: red
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
