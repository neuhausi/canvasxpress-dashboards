/**
 * Minimal VCF (Variant Call Format) reader — dependency-free.
 *
 * Parses VCF 4.x text into plain records and into a CanvasXpress data object so
 * a variant table / per-chromosome summary / Manhattan panel can bind it. This
 * is a pragmatic reader for the common case (SNVs and small indels with the
 * eight fixed columns, optional FORMAT + genotype samples); it does not
 * implement the full structural-variant / breakend grammar.
 *
 * @module vcf
 */

var FIXED = ['CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO'];

/**
 * Parse the INFO column (`key=value;flag;key2=v2`) into an object. A bare flag
 * becomes `true`; a comma list stays a string (callers split if they need to).
 * @param {string} info - The INFO field.
 * @returns {object} Parsed key/value pairs.
 * @private
 */
function parseInfo(info) {
  var out = {};
  if (!info || info === '.') return out;
  info.split(';').forEach(function (part) {
    if (!part) return;
    var eq = part.indexOf('=');
    if (eq === -1) out[part] = true;
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  });
  return out;
}

/**
 * Parse VCF text into records and metadata.
 * @param {string} text - VCF file contents.
 * @returns {{meta: Array<string>, samples: Array<string>,
 *   records: Array<object>}} `meta` = `##` header lines; `samples` = genotype
 *   column names; each record has `CHROM, POS (number), ID, REF, ALT, QUAL
 *   (number|null), FILTER, INFO (object), info (raw), samples{name: genotype}`.
 * @public
 */
export function parseVcf(text) {
  var lines = String(text == null ? '' : text).split(/\r?\n/);
  var meta = [];
  var sampleNames = [];
  var records = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (line === '' ) continue;
    if (line.charAt(0) === '#') {
      if (line.charAt(1) === '#') { meta.push(line); continue; }
      // The #CHROM header: columns 9+ are sample names.
      var cols = line.replace(/^#/, '').split('\t');
      sampleNames = cols.slice(9);
      continue;
    }
    var f = line.split('\t');
    if (f.length < 8) continue;
    var qual = f[5];
    var rec = {
      CHROM: f[0], POS: Number(f[1]), ID: f[2], REF: f[3], ALT: f[4],
      QUAL: (qual === '.' || qual === '' || qual == null) ? null : Number(qual),
      FILTER: f[6], info: f[7], INFO: parseInfo(f[7]), samples: {}
    };
    if (f.length > 9 && sampleNames.length) {
      var format = f[8].split(':');
      for (var s = 0; s < sampleNames.length; s++) {
        var vals = (f[9 + s] || '').split(':');
        var gt = {};
        for (var k = 0; k < format.length; k++) gt[format[k]] = vals[k];
        rec.samples[sampleNames[s]] = gt;
      }
    }
    records.push(rec);
  }
  return { meta: meta, samples: sampleNames, records: records };
}

/**
 * Convert parsed VCF records into a CanvasXpress data object: one row per
 * variant, `POS`/`QUAL` as measures, and `CHROM`/`REF`/`ALT`/`FILTER` (plus any
 * requested INFO keys) as annotations.
 * @param {{records: Array<object>}|Array<object>} parsed - {@link parseVcf}
 *   output, or its `records` array.
 * @param {object} [options] - Options.
 * @param {Array<string>} [options.info] - INFO keys to lift into annotations.
 * @returns {object} A CanvasXpress data object (`y.smps` = variant ids).
 * @public
 */
export function vcfToData(parsed, options) {
  options = options || {};
  var records = Array.isArray(parsed) ? parsed : (parsed && parsed.records) || [];
  var infoKeys = options.info || [];
  var smps = records.map(function (r, i) {
    return (r.ID && r.ID !== '.') ? r.ID : (r.CHROM + ':' + r.POS);
  });
  var x = {
    CHROM: records.map(function (r) { return r.CHROM; }),
    REF: records.map(function (r) { return r.REF; }),
    ALT: records.map(function (r) { return r.ALT; }),
    FILTER: records.map(function (r) { return r.FILTER; })
  };
  infoKeys.forEach(function (key) {
    x[key] = records.map(function (r) {
      var v = r.INFO[key];
      return v === undefined ? null : v;
    });
  });
  return {
    y: {
      vars: ['POS', 'QUAL'], smps: smps,
      data: records.map(function (r) { return [r.POS, r.QUAL]; })
    },
    x: x
  };
}

/**
 * Count variants per chromosome, in first-seen order — a quick VCF summary that
 * binds straight to a Bar panel.
 * @param {{records: Array<object>}|Array<object>} parsed - {@link parseVcf}
 *   output, or its `records` array.
 * @returns {object} A CanvasXpress data object (`y.smps` = chromosomes).
 * @public
 */
export function variantsPerChromosome(parsed) {
  var records = Array.isArray(parsed) ? parsed : (parsed && parsed.records) || [];
  var order = [];
  var counts = Object.create(null);
  records.forEach(function (r) {
    if (!(r.CHROM in counts)) { counts[r.CHROM] = 0; order.push(r.CHROM); }
    counts[r.CHROM]++;
  });
  return {
    y: { vars: ['Variants'], smps: order, data: [order.map(function (c) { return counts[c]; })] }
  };
}
