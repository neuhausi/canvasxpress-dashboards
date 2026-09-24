/**
 * Generate the options-wall dashboard spec from the real IBM fixture
 * (examples/data/ibm-optionswall.json).
 *
 * Emits examples/options-wall.spec.json — a single OptionsWall panel plus two
 * `mode:"config"` controls that drive its live config (updateConfig):
 *   - priceHistory : IBM daily OHLC (the candlestick price core).
 *   - expiry slider: one option per expiry, each carrying that expiry's chain.
 *   - metric toggle: IV vs Premium flanks, each with its pinned axis window.
 *
 * Run: node examples/gen-optionswall.cjs   (from the repo root)
 */
'use strict';
var fs = require('fs');
var path = require('path');

var SRC = path.join(__dirname, 'data', 'ibm-optionswall.json');
var multi = JSON.parse(fs.readFileSync(SRC, 'utf8'));

var symbol = multi.symbol;             // "IBM"
var spot = multi.spot;                 // 235.59
var expiries = multi.expiries;         // ["2026-09-04", ...]
var chains = multi.chains;

// --- priceHistory: full OHLC, last 60 trading days (keep the panel light) ---
var allDates = multi.data.y.smps;
var ohlcVars = multi.data.y.vars;      // ["Open","High","Low","Close"]
var keep = 60;
var start = Math.max(0, allDates.length - keep);
var dates = allDates.slice(start);
var ohlcData = ohlcVars.map(function (v, vi) {
  return multi.data.y.data[vi].slice(start);
});
var priceHistory = { y: { vars: ohlcVars, smps: dates, data: ohlcData } };

// Label an expiry as a plain month-day-year string for the slider readout.
function expiryLabel(expiry) {
  var m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var parts = expiry.split('-');
  return m[parseInt(parts[1], 10) - 1] + ' ' + parseInt(parts[2], 10) + ', ' + parts[0];
}

// --- OptionsWall panel + config-control fragments ---
var nearest = expiries[0];
function globalMax(side, met) {
  var mx = 0;
  for (var i = 0; i < expiries.length; i++) {
    var s = chains[expiries[i]][side]; if (!s) continue;
    var arr = s[met] || s.premium || [];
    for (var j = 0; j < arr.length; j++) { var v = arr[j]; if (v != null && !isNaN(v) && v > mx) mx = v; }
  }
  return mx > 0 ? mx : 1;
}
function niceCeil(v) {
  if (v <= 0) return 1;
  var mag = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
  var steps = [1, 2, 2.5, 5, 10];
  for (var i = 0; i < steps.length; i++) { var t = steps[i] * mag; if (t >= v) return t; }
  return 10 * mag;
}
// Axis windows per flank metric — pinned across ALL expiries so the walls keep a
// constant scale while the slider moves (each metric has its own global max).
function metricAxes(met) {
  return {
    optionsWallFlankMetric: met,
    optionsWallPutMin: 0, optionsWallPutMax: niceCeil(globalMax('put', met)),
    optionsWallCallMin: 0, optionsWallCallMax: niceCeil(globalMax('call', met))
  };
}
var ivAxes = metricAxes('iv');

// Keep the vertical price/strike axis (and thus its tick labels) IDENTICAL as the
// slider moves. The OptionsWall geom derives that axis from each chain's own
// min/max strike combined with the price history — and its config `optionsWallDomain`
// is drag-only state the engine does NOT copy from config, so it can't pin it.
// Instead give every chain the SAME strike extent: the global min/max strike across
// all expiries, injected as sentinel rows with no metric (iv/premium null → the flank
// curve gaps over them; volume 0 → no bar), so they extend the ladder invisibly and
// the natural domain lands on the same value for every frame.
var gMinStrike = Infinity, gMaxStrike = -Infinity;
for (var ei = 0; ei < expiries.length; ei++) {
  var ss = chains[expiries[ei]].strikes || [];
  for (var si = 0; si < ss.length; si++) {
    if (ss[si] < gMinStrike) gMinStrike = ss[si];
    if (ss[si] > gMaxStrike) gMaxStrike = ss[si];
  }
}
function padChain(chain) {
  var strikes = chain.strikes.slice();
  var put = { premium: chain.put.premium.slice(), iv: chain.put.iv.slice(), volume: chain.put.volume.slice() };
  var call = { premium: chain.call.premium.slice(), iv: chain.call.iv.slice(), volume: chain.call.volume.slice() };
  function addSentinel(strike, atFront) {
    var m = atFront ? 'unshift' : 'push';
    strikes[m](strike);
    put.premium[m](null); put.iv[m](null); put.volume[m](0);
    call.premium[m](null); call.iv[m](null); call.volume[m](0);
  }
  if (strikes[0] > gMinStrike) addSentinel(gMinStrike, true);
  if (strikes[strikes.length - 1] < gMaxStrike) addSentinel(gMaxStrike, false);
  return { strikes: strikes, expiry: chain.expiry, put: put, call: call };
}

// Label an expiry with days-out from the last price session (the fixture's
// most-recent trading day), matching the standalone page's readout.
var lastSession = dates[dates.length - 1];
function daysOut(expiry) {
  var d0 = new Date(lastSession + 'T00:00:00Z'), d1 = new Date(expiry + 'T00:00:00Z');
  var n = Math.round((d1 - d0) / 86400000);
  return n >= 0 ? (n + 'd') : ('-' + (-n) + 'd');
}

// Expiry slider: one option per expiry, each carrying that expiry's chain.
var expiryOptions = expiries.map(function (e) {
  return {
    label: expiryLabel(e) + ' · ' + daysOut(e),
    value: e,
    config: { optionsWallExpiry: e, optionsWallChain: padChain(chains[e]) }
  };
});

// Metric toggle: IV vs Premium flanks (with each metric's pinned axis window).
var metricOptions = [
  { label: 'IV', value: 'iv', config: metricAxes('iv') },
  { label: 'Premium', value: 'premium', config: metricAxes('premium') }
];

var wallConfig = {
  graphType: 'OptionsWall',
  optionsWallSpot: spot,
  optionsWallExpiry: nearest,
  optionsWallChain: padChain(chains[nearest]),
  optionsWallFlankMetric: ivAxes.optionsWallFlankMetric,
  optionsWallPutMin: ivAxes.optionsWallPutMin, optionsWallPutMax: ivAxes.optionsWallPutMax,
  optionsWallCallMin: ivAxes.optionsWallCallMin, optionsWallCallMax: ivAxes.optionsWallCallMax,
  title: false
};

var spec = {
  id: 'options-wall',
  title: 'IBM Options Wall',
  version: 1,
  broadcastGroup: 'options-wall',
  theme: 'auto',
  layout: {
    cols: 12,
    rowHeight: 40,
    gap: 12,
    items: [
      { panel: 'expiry-slider', x: 0, y: 0, w: 8, h: 2 },
      { panel: 'metric-toggle', x: 8, y: 0, w: 4, h: 2 },
      { panel: 'wall', x: 0, y: 2, w: 12, h: 14 }
    ]
  },
  data: {
    priceHistory: { kind: 'inline', value: priceHistory }
  },
  panels: {
    'expiry-slider': {
      type: 'control', mode: 'config', target: 'wall', style: 'slider',
      title: 'Expiry', value: nearest, options: expiryOptions
    },
    'metric-toggle': {
      type: 'control', mode: 'config', target: 'wall', style: 'buttons',
      title: 'Flank metric', value: 'iv', options: metricOptions
    },
    'wall': {
      title: symbol + ' Options Wall',
      dataRef: 'priceHistory', config: wallConfig
    }
  }
};

var out = path.join(__dirname, 'options-wall.spec.json');
fs.writeFileSync(out, JSON.stringify(spec, null, 2));
console.log('wrote', out);
console.log('expiries:', expiries.length, '| price sessions:', dates.length);
