/**
 * Adornments for dashboard control widgets: the leading role icon and the
 * colour/shape swatches that tie a control's choices to the way the data is
 * drawn in the panels it drives.
 *
 * Two deliberate rules:
 *  - An icon is chosen from what the control DOES (its role: filter, search,
 *    x-axis, colour, transform ...), never guessed from the column's name —
 *    a spec may override it with `icon: "<name>"` (or suppress it with
 *    `icon: false`).
 *  - A swatch is read back from a live CanvasXpress instance's legend render
 *    objects, so the dot in the control is the exact colour/shape the chart
 *    drew for that level — it is never recomputed from a palette.
 */

/* Icon set. 16x16 viewBox, stroked with currentColor so the icon inherits the
   control's (muted) text colour and both themes work without extra rules. */
export var CONTROL_ICONS = {
  'filter': '<path d="M2.5 3.5h11l-4.3 5v4.2l-2.4 1.3V8.5z"/>',
  'search': '<circle cx="7" cy="7" r="4"/><path d="M10 10l3.5 3.5"/>',
  'axis-x': '<path d="M2 8h12M4.5 5.5 2 8l2.5 2.5M11.5 5.5 14 8l-2.5 2.5"/>',
  'axis-y': '<path d="M8 2v12M5.5 4.5 8 2l2.5 2.5M5.5 11.5 8 14l2.5-2.5"/>',
  'color': '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11"/>',
  'shape': '<path d="M8 2.5 13.5 13H2.5z"/>',
  'size': '<circle cx="5" cy="11" r="2.2"/><circle cx="10.5" cy="6.5" r="4"/>',
  'transform': '<path d="M3 5h10M3 11h10"/><circle cx="6" cy="5" r="1.6"/><circle cx="10.5" cy="11" r="1.6"/>',
  'slider': '<path d="M2.5 8h11"/><circle cx="9.5" cy="8" r="2.4"/>',
  'time': '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.3 1.6"/>',
  'place': '<path d="M8 14s4.5-4.2 4.5-7.4A4.5 4.5 0 0 0 3.5 6.6C3.5 9.8 8 14 8 14z"/><circle cx="8" cy="6.5" r="1.7"/>',
  'sex': '<circle cx="8" cy="6" r="3.3"/><path d="M8 9.3v4.4M6.2 12h3.6"/>',
  'group': '<circle cx="5.5" cy="6" r="2.2"/><circle cx="10.5" cy="6" r="2.2"/><path d="M2.5 13c.6-2 1.7-3 3-3M13.5 13c-.6-2-1.7-3-3-3"/>',
  'tag': '<path d="M8.3 2.5H13.5V7.7L8 13.2 2.8 8z"/><circle cx="10.8" cy="5.2" r="1"/>',
  'calendar': '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
  'sort': '<path d="M4.5 3v10M2.5 10.5 4.5 13l2-2.5M11.5 13V3M9.5 5.5 11.5 3l2 2.5"/>',
  'layers': '<path d="M8 2.5 14 6 8 9.5 2 6z"/><path d="M2 9.5 8 13l6-3.5"/>'
};

/* Config-control inference: the first matching pattern over the config keys the
   control's options set decides the icon. Ordered — most specific first. */
var CONFIG_KEY_ICONS = [
  [/^(xaxis|x|xaxistitle)$/i, 'axis-x'],
  [/^(yaxis|y|yaxistitle)$/i, 'axis-y'],
  [/color/i, 'color'],
  [/shape/i, 'shape'],
  [/size/i, 'size'],
  [/^(sortby|sortdir|order)/i, 'sort'],
  [/^(graphtype|layout|stack)/i, 'layers']
];

/**
 * The icon name for a control, from its ROLE (what it drives), with the spec's
 * `icon` as an override. Returns null when the control should carry no icon.
 * @param {object} panel - The control panel.
 * @returns {?string} An icon name, a literal glyph (1-2 chars), or null.
 * @public
 */
export function controlIconName(panel) {
  if (!panel) return null;
  // Explicit override: false/'' suppresses; a known name wins; a short string
  // is taken as a literal glyph (an emoji or a symbol the author wants).
  if (panel.icon === false || panel.icon === '') return null;
  if (typeof panel.icon === 'string') {
    if (Object.prototype.hasOwnProperty.call(CONTROL_ICONS, panel.icon)) return panel.icon;
    return panel.icon.length <= 2 ? panel.icon : null;
  }
  var style = panel.style || '';
  if (panel.mode === 'transform') return 'transform';
  if (style === 'search') return 'search';
  if (style === 'range' || style === 'slider') return 'slider';
  if (panel.mode === 'config') return configControlIcon(panel);
  // Filter and param controls both narrow the data to a chosen value.
  return 'filter';
}

/**
 * The icon for a config control, inferred from the config keys its options set
 * (an x-axis switcher gets ↔, a colour switcher a colour wheel, ...).
 * @param {object} panel - A `mode:"config"` control panel.
 * @returns {string} An icon name (falls back to 'layers').
 * @private
 */
function configControlIcon(panel) {
  var keys = {};
  var options = panel.options || [];
  for (var i = 0; i < options.length; i++) {
    var config = options[i] && options[i].config;
    if (!config || typeof config !== 'object') continue;
    for (var k in config) { if (Object.prototype.hasOwnProperty.call(config, k)) keys[k] = true; }
  }
  var names = Object.keys(keys);
  for (var r = 0; r < CONFIG_KEY_ICONS.length; r++) {
    for (var n = 0; n < names.length; n++) {
      if (CONFIG_KEY_ICONS[r][0].test(names[n])) return CONFIG_KEY_ICONS[r][1];
    }
  }
  return 'layers';
}

/**
 * Build the leading icon element for a control, or null when it has none.
 * @param {object} panel - The control panel.
 * @param {Document} [doc] - Document to create in (defaults to the global one).
 * @returns {?HTMLElement} A `.cxd-annctl-ic` span, or null.
 * @public
 */
export function controlIconNode(panel, doc) {
  var name = controlIconName(panel);
  if (!name) return null;
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return null;
  var span = d.createElement('span');
  span.className = 'cxd-annctl-ic';
  span.setAttribute('aria-hidden', 'true');
  if (Object.prototype.hasOwnProperty.call(CONTROL_ICONS, name)) {
    span.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
      'stroke-linecap="round" stroke-linejoin="round">' + CONTROL_ICONS[name] + '</svg>';
  } else {
    span.className += ' cxd-annctl-ic-glyph';
    span.textContent = name;   // a literal glyph from the spec
  }
  return span;
}

/* Legend render-object ids look like PropertyKey:<annotation>:<level>:<compartment>;
   the key's drawShape carries the shape name and the fill the chart actually used. */
var TRANSPARENT = /^(transparent$|rgba?\([^)]*,\s*0(\.0+)?\s*\)$)/i;

/**
 * Read a live instance's legend back into a level → {color, shape} map for one
 * annotation. Uses the legend's own render objects, so the swatch matches what
 * was drawn (scheme, overrides, custom colours and all) rather than a guess.
 * @param {object} instance - A rendered CanvasXpress instance.
 * @param {string} annotation - The annotation the control is bound to.
 * @returns {?object} level → {color, shape}, or null when the chart does not key on it.
 * @public
 */
export function legendKeyMap(instance, annotation) {
  if (!instance || !annotation) return null;
  var objects = instance.meta && instance.meta.render && instance.meta.render.objects;
  if (!Array.isArray(objects)) return null;
  var prefix = 'PropertyKey:' + annotation + ':';
  var map = {};
  var found = false;
  for (var i = 0; i < objects.length; i++) {
    var obj = objects[i];
    var id = obj && obj.id;
    if (typeof id !== 'string' || id.indexOf(prefix) !== 0) continue;
    if (obj.func !== 'drawShape' || !Array.isArray(obj.params)) continue;
    var rest = id.slice(prefix.length);
    var cut = rest.lastIndexOf(':');            // trailing :x / :z compartment
    var level = cut > 0 ? rest.slice(0, cut) : rest;
    var shape = String(obj.params[0] || '');
    var fill = obj.params[5];
    // The key draws a transparent backing rectangle first; the coloured mark
    // that follows is the one worth showing.
    if (typeof fill !== 'string' || TRANSPARENT.test(fill)) continue;
    if (shape === 'rectangle' && map[level]) continue;
    map[level] = { color: fill, shape: shape };
    found = true;
  }
  return found ? map : null;
}

/* CanvasXpress shape names → a CSS rendering of the same silhouette. */
var SHAPE_CSS = {
  sphere: { radius: '50%' },
  circle: { radius: '50%' },
  square: { radius: '2px' },
  rectangle: { radius: '2px' },
  triangle: { clip: 'polygon(50% 0%, 100% 100%, 0% 100%)' },
  'triangle-down': { clip: 'polygon(0% 0%, 100% 0%, 50% 100%)' },
  diamond: { clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
  star: { clip: 'polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)' },
  mdavid: { clip: 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)' },
  octagon: { radius: '30%' },
  hexagon: { clip: 'polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%)' }
};

/**
 * Build a swatch element for one level's drawn colour/shape.
 * @param {object} key - `{color, shape}` from {@link legendKeyMap}.
 * @param {Document} [doc] - Document to create in.
 * @returns {?HTMLElement} A `.cxd-annctl-sw` span, or null without a colour.
 * @public
 */
export function swatchNode(key, doc) {
  if (!key || !key.color) return null;
  var d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return null;
  var span = d.createElement('span');
  span.className = 'cxd-annctl-sw';
  span.setAttribute('aria-hidden', 'true');
  span.style.backgroundColor = key.color;
  var css = SHAPE_CSS[String(key.shape || '').toLowerCase()];
  if (css && css.clip) { span.style.clipPath = css.clip; span.style.borderRadius = '0'; }
  else if (css && css.radius) span.style.borderRadius = css.radius;
  return span;
}
