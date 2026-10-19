/**
 * Unit tests for the Publication Figure Composer (figure-composer plan P2–P4):
 * journal sizing, the composition model (order + labels + grid), and the
 * composite true-vector SVG. Panel SVGs are stubbed so no browser/engine is
 * needed; the real engine seam is covered by the browser verify at P5.
 *
 * Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  JOURNAL_PRESETS, mmToPx, figureDimensions,
  composeFigureModel, composeFigureSvg
} from '../src/figureComposer.js';

/**
 * A fake live handle with a grid layout of graph + non-graph panels and a
 * stub SVG per panel (so composition is testable without the engine).
 * @param {object} [overrides] - `{ layout, panels }` overrides.
 * @returns {object} A minimal handle with spec + panelInstances().
 */
function fakeHandle(overrides) {
  overrides = overrides || {};
  var spec = {
    layout: overrides.layout || {
      cols: 12,
      items: [
        { panel: 'intro', x: 0, y: 0, w: 12, h: 2 },   // text panel (type set)
        { panel: 'box', x: 0, y: 2, w: 6, h: 8 },
        { panel: 'scatter', x: 6, y: 2, w: 6, h: 8 },
        { panel: 'heat', x: 0, y: 10, w: 12, h: 6 }
      ]
    },
    panels: overrides.panels || {
      intro: { type: 'text', title: 'Intro' },
      box: { title: 'Box', config: { graphType: 'Boxplot' } },
      scatter: { title: 'Scatter', config: { graphType: 'Scatter2D' } },
      heat: { title: 'Heatmap', config: { graphType: 'Heatmap' } }
    }
  };
  var instances = {};
  Object.keys(spec.panels).forEach(function (id) {
    if (spec.panels[id].type) return;
    instances[id] = {
      getSVGString: function () {
        return '<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="680" height="440" desc="">' +
          '<desc>' + id + '</desc><rect width="680" height="440" fill="#fff"/>' +
          '<text x="10" y="20">' + id + '-label</text></svg>';
      }
    };
  });
  return { spec: spec, panelInstances: function () { return instances; } };
}

/* ----------------------------- P3 sizing ------------------------------ */

test('mmToPx: 25.4mm at 300dpi is 300px', function () {
  assert.equal(mmToPx(25.4, 300), 300);
});

test('figureDimensions: Nature one-column at 300dpi', function () {
  var d = figureDimensions({ preset: 'nature', columns: 'one', dpi: 300, aspect: 0.75 });
  assert.equal(d.widthMm, 89);
  assert.equal(d.widthPx, mmToPx(89, 300));
  assert.equal(d.heightPx, mmToPx(89 * 0.75, 300));
  assert.equal(d.dpi, 300);
});

test('figureDimensions: two-column + explicit overrides', function () {
  assert.equal(figureDimensions({ preset: 'cell', columns: 'two' }).widthMm, JOURNAL_PRESETS.cell.twoCol);
  var d = figureDimensions({ widthMm: 120, heightMm: 60, dpi: 600 });
  assert.equal(d.widthPx, mmToPx(120, 600));
  assert.equal(d.heightPx, mmToPx(60, 600));
});

test('figureDimensions: unknown preset falls back to generic', function () {
  assert.equal(figureDimensions({ preset: 'nope', columns: 'one' }).widthMm, JOURNAL_PRESETS.generic.oneCol);
});

/* --------------------------- P2 model --------------------------------- */

test('composeFigureModel: graph panels only, reading order, A/B/C labels', function () {
  var model = composeFigureModel(fakeHandle());
  assert.deepEqual(model.panels.map(function (p) { return p.id; }), ['box', 'scatter', 'heat']);
  assert.deepEqual(model.panels.map(function (p) { return p.label; }), ['A', 'B', 'C']);
  // 'intro' (a text panel) is excluded.
  assert.ok(!model.panels.some(function (p) { return p.id === 'intro'; }));
});

test('composeFigureModel: grid re-based to the selection bounding box', function () {
  var model = composeFigureModel(fakeHandle());
  // Top-left of the selection should re-base to y=0 (the text panel at y0 is gone).
  assert.equal(Math.min.apply(null, model.panels.map(function (p) { return p.y; })), 0);
});

test('composeFigureModel: explicit panel order overrides layout', function () {
  var model = composeFigureModel(fakeHandle(), { panels: ['heat', 'box'], labelStyle: '1' });
  assert.deepEqual(model.panels.map(function (p) { return p.id; }), ['heat', 'box']);
  assert.deepEqual(model.panels.map(function (p) { return p.label; }), ['1', '2']);
});

test('composeFigureModel: labelStyle "none" yields empty labels', function () {
  var model = composeFigureModel(fakeHandle(), { labelStyle: 'none' });
  assert.ok(model.panels.every(function (p) { return p.label === ''; }));
});

test('composeFigureModel: no-grid layout packs near-square', function () {
  var handle = fakeHandle({
    layout: { items: [] },
    panels: { a: {}, b: {}, c: {}, d: {} }
  });
  var model = composeFigureModel(handle);
  assert.equal(model.panels.length, 4);
  assert.equal(model.cols, 2);  // ceil(sqrt(4))
});

/* --------------------------- P4 composite ----------------------------- */

test('composeFigureSvg: one standalone SVG embedding every panel + labels', function () {
  var out = composeFigureSvg(fakeHandle(), { preset: 'nature', columns: 'two', dpi: 300, caption: 'Figure 1.' });
  var svg = out.svg;
  assert.match(svg, /^<\?xml/, 'xml prolog');
  assert.match(svg, /<svg\b[^>]*\bwidth="\d+"/, 'outer svg has pixel width');
  assert.equal((svg.match(/<svg\b/g) || []).length, 1 + 3, 'outer + one nested svg per graph panel');
  // Each placed panel got a viewBox (so it scales) and placement coords.
  assert.equal((svg.match(/viewBox="0 0 680 440"/g) || []).length, 3);
  // Subplot labels drawn.
  ['>A<', '>B<', '>C<'].forEach(function (lbl) { assert.ok(svg.indexOf(lbl) !== -1, 'label ' + lbl); });
  // Shared caption present (escaped).
  assert.ok(svg.indexOf('Figure 1.') !== -1);
  // Panel content survives (true vector, not rasterized).
  assert.ok(svg.indexOf('box-label') !== -1 && svg.indexOf('heat-label') !== -1);
  assert.equal((svg.match(/<image\b/g) || []).length, 0, 'no raster image embeds');
});

test('composeFigureSvg: size matches the requested journal preset', function () {
  var out = composeFigureSvg(fakeHandle(), { preset: 'nature', columns: 'one', dpi: 300 });
  assert.equal(out.size.widthPx, mmToPx(89, 300));
  assert.match(out.svg, new RegExp('width="' + out.size.widthPx + '"'));
});

test('composeFigureSvg: placement x/y differ per panel (panels are laid out, not stacked)', function () {
  var out = composeFigureSvg(fakeHandle(), { labelStyle: 'none' });
  var xs = (out.svg.match(/<svg\b[^>]*\bx="([\d.]+)"/g) || []);
  assert.ok(xs.length >= 2, 'nested panels carry x placement');
});

test('composeFigureSvg: throws when there are no graph panels', function () {
  var handle = fakeHandle({ layout: { items: [] }, panels: { note: { type: 'text' } } });
  assert.throws(function () { composeFigureSvg(handle); }, /no graph panels/);
});

test('composeFigureSvg: custom panelSvg provider is honoured', function () {
  var out = composeFigureSvg(fakeHandle(), {
    panelSvg: function (id) { return '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle/></svg>'; }
  });
  assert.equal((out.svg.match(/<circle/g) || []).length, 3);
});
