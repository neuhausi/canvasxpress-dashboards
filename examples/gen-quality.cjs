// Deterministic generator for the quality-metrics dashboard spec.
// Index-derived pseudo-noise only (no Math.random / Date.now). Run: node gen-quality.cjs
const fs = require('fs');

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s |= 0; s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(r) { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const round = (x, d) => Number(x.toFixed(d));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// ---- production lines with distinct personalities --------------------------
const LINES = ['Line A', 'Line B', 'Line C', 'Line D'];
const SHIFTS = ['Day', 'Night'];
// baseline quality per line: A star, B solid, C struggler, D middle
const profile = {
  'Line A': { yield: 97, defect: 1.6, ontime: 98 },
  'Line B': { yield: 94, defect: 3.0, ontime: 95 },
  'Line C': { yield: 88, defect: 6.4, ontime: 90 },
  'Line D': { yield: 92, defect: 4.1, ontime: 93 }
};

// ---- 500 inspection records (125 per line, alternating shift) --------------
const N = 500;
const rec = [];
// per-line drift across the inspection sequence (0..124): Line C climbs from an
// improvement program, Line A holds, others gently rise — visible in the run chart.
const seqDrift = { 'Line A': s => 0.01 * s, 'Line B': s => -1.2 * Math.sin(s / 124 * Math.PI), 'Line C': s => 0.075 * s, 'Line D': s => 0.03 * s };
for (let i = 0; i < N; i++) {
  const line = LINES[i % 4];
  const seq = Math.floor(i / 4);                        // 0..124 position within the line
  const shift = SHIFTS[seq % 2];                        // Night shift a touch worse
  const p = profile[line];
  const nightYield = shift === 'Night' ? -2.2 : 0;
  const nightDefect = shift === 'Night' ? 1.1 : 0;
  const nightOntime = shift === 'Night' ? -3.0 : 0;
  const yieldPct = round(clamp(p.yield + seqDrift[line](seq) + nightYield + gauss(rng(i * 7 + 1)) * 1.6, 60, 100), 2);
  const defectPct = round(clamp(p.defect + nightDefect + gauss(rng(i * 11 + 3)) * 0.8, 0, 20), 2);
  const ontimePct = round(clamp(p.ontime + nightOntime + gauss(rng(i * 13 + 5)) * 2.0, 50, 100), 2);
  rec.push({ line, shift, yieldPct, defectPct, ontimePct });
}
const recSmps = rec.map((_, i) => 'INSP' + String(i + 1).padStart(3, '0'));
const recAnn = { Line: rec.map(r => r.line), Shift: rec.map(r => r.shift) };
// One SINGLE-VARIABLE dataset per meter: resetDataFilter() rebuilds a meter's
// default xAxis from all variables, so a lone variable keeps "All" correct.
const yieldRecords = { y: { vars: ['Yield'], smps: recSmps, data: [rec.map(r => r.yieldPct)] }, x: recAnn };
const defectRecords = { y: { vars: ['Defects'], smps: recSmps, data: [rec.map(r => r.defectPct)] }, x: recAnn };
const ontimeRecords = { y: { vars: ['OnTime'], smps: recSmps, data: [rec.map(r => r.ontimePct)] }, x: recAnn };
// COUNT meter: one row per inspection = 1, summed. Unlike the rate meters
// (which average %), this is a volume, so "All" = Line A + B + C + D = 500.
const countRecords = { y: { vars: ['Inspections'], smps: recSmps, data: [rec.map(() => 1)] }, x: recAnn };

// ---- yield RUN CHART: all 500 inspections, 4 series x 125 points ------------
// Reshapes the 500 records into one line per production line (125 inspections
// each), so the line chart plots all 500 data points as a control/run chart.
const SEQ = N / 4;                          // 125 inspections per line
const seqLabels = Array.from({ length: SEQ }, (_, s) => String(s + 1));
const trendData = LINES.map((line, li) =>
  Array.from({ length: SEQ }, (_, s) => rec[s * 4 + li].yieldPct));   // index s*4+li has line == LINES[li]
const trend = {
  y: { vars: LINES, smps: seqLabels, data: trendData },
  z: { Line: LINES }                       // series-level annotation → Line control hides other series
};

// ---- defect BAR chart: one bar per inspection (all 500), coloured by line ---
const defectBars = {
  y: { vars: ['Defects'], smps: recSmps, data: [rec.map(r => r.defectPct)] },
  x: recAnn                                 // Line + Shift → controls filter the bars
};

// ---- assemble spec ---------------------------------------------------------
const inline = v => ({ kind: 'inline', value: v });
const spec = {
  id: 'quality-metrics',
  title: 'Manufacturing Quality Metrics',
  version: 1,
  broadcastGroup: 'quality-metrics',
  theme: 'auto',
  layout: {
    cols: 12,
    rowHeight: 40,
    gap: 12,
    items: [
      { panel: 'line-control', x: 0, y: 0, w: 6, h: 1 },
      { panel: 'shift-control', x: 6, y: 0, w: 6, h: 1 },
      { panel: 'yield-meter', x: 0, y: 1, w: 3, h: 6 },
      { panel: 'defect-meter', x: 3, y: 1, w: 3, h: 6 },
      { panel: 'ontime-meter', x: 6, y: 1, w: 3, h: 6 },
      { panel: 'count-meter', x: 9, y: 1, w: 3, h: 6 },
      { panel: 'trend', x: 0, y: 7, w: 12, h: 8 },
      { panel: 'defects-bar', x: 0, y: 15, w: 12, h: 8 }
    ]
  },
  data: {
    yieldRecords: inline(yieldRecords),
    defectRecords: inline(defectRecords),
    ontimeRecords: inline(ontimeRecords),
    countRecords: inline(countRecords),
    trend: inline(trend),
    defectBars: inline(defectBars)
  },
  panels: {
    'line-control': {
      type: 'control', title: 'Production Line', dataRef: 'yieldRecords',
      annotation: 'Line', style: 'dropdown'
    },
    'shift-control': {
      type: 'control', title: 'Shift', dataRef: 'yieldRecords',
      annotation: 'Shift', style: 'buttons'
    },
    'yield-meter': {
      title: 'First-Pass Yield · avg %',
      dataRef: 'yieldRecords',
      config: {
        graphType: 'Meter', meterType: 'ring', meterCard: true, summaryType: 'average',
        xAxis: ['Yield'], setMin: 0, setMax: 100, rangeColors: ['rgb(38,166,154)'], title: false
      }
    },
    'defect-meter': {
      title: 'Defect Rate · avg %',
      dataRef: 'defectRecords',
      config: {
        graphType: 'Meter', meterType: 'ring', meterCard: true, summaryType: 'average',
        xAxis: ['Defects'], setMin: 0, setMax: 10, rangeColors: ['rgb(229,57,53)'], title: false
      }
    },
    'ontime-meter': {
      title: 'On-Time Delivery · avg %',
      dataRef: 'ontimeRecords',
      config: {
        graphType: 'Meter', meterType: 'ring', meterCard: true, summaryType: 'average',
        xAxis: ['OnTime'], setMin: 0, setMax: 100, rangeColors: ['rgb(41,121,255)'], title: false
      }
    },
    'count-meter': {
      title: 'Total Inspections · count',
      dataRef: 'countRecords',
      config: {
        graphType: 'Meter', meterType: 'ring', meterCard: true, summaryType: 'sum',
        xAxis: ['Inspections'], setMin: 0, setMax: 500, rangeColors: ['rgb(124,77,255)'], title: false
      }
    },
    trend: {
      title: 'First-Pass Yield Run Chart · 500 inspections (125 per line)',
      dataRef: 'trend',
      config: {
        graphType: 'Line', graphOrientation: 'vertical',
        // for these vertical charts the axis titles map to DATA axes: xAxisTitle
        // labels the value axis, yAxisTitle the category axis.
        xAxisTitle: 'Yield (%)', yAxisTitle: 'Inspection # (per line)',
        smpLabelInterval: 12,
        smpTextRotate: 90,
        smpTextScaleFontFactor: 0.8,
        smpTitleScaleFontFactor: 0.8,
        title: false
      }
    },
    'defects-bar': {
      title: 'Defect Rate per Inspection · 500 inspections',
      dataRef: 'defectBars',
      config: {
        graphType: 'Bar', graphOrientation: 'vertical', colorBy: 'Line',
        xAxisTitle: 'Defect Rate (%)', yAxisTitle: 'Inspection',
        // Same label config as the run chart, but the Bar renderer does NOT
        // honor smpLabelInterval for 500 samples (it draws all 500, overlapping),
        // so per-bar names stay hidden; the font-scale keys still apply.
        showSampleNames: false,
        smpLabelInterval: 12,
        smpTextRotate: 90,
        smpTextScaleFontFactor: 0.8,
        smpTitleScaleFontFactor: 0.8,
        title: false
      }
    }
  }
};

fs.writeFileSync('quality-metrics.spec.json', JSON.stringify(spec, null, 2));
const avg = (k) => round(rec.reduce((s, r) => s + r[k], 0) / rec.length, 2);
console.log('wrote quality-metrics.spec.json | records:', N,
  '| avg yield', avg('yieldPct'), '| avg defect', avg('defectPct'), '| avg ontime', avg('ontimePct'));
