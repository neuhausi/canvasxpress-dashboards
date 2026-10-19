/**
 * Over-representation (enrichment) analysis — dependency-free.
 *
 * Given a query set (e.g. the genes a scientist selected in a panel, the P4
 * marked set) and a collection of annotated gene sets (pathways), score each
 * pathway for over-representation with the hypergeometric test (equivalently
 * the one-tailed Fisher exact test) and correct across pathways with
 * Benjamini-Hochberg FDR.
 *
 * This keeps enrichment self-contained in the dashboards layer. When the
 * engine's shared multiple-testing correction lands, the
 * BH step here can delegate to it; the hypergeometric core stays.
 *
 * @module enrichment
 */

/**
 * Natural log of the gamma function (Lanczos approximation, g=7). Accurate to
 * ~1e-13 for positive arguments — enough for log-factorials over gene-set sizes.
 * @param {number} x - A positive number.
 * @returns {number} ln(Γ(x)).
 * @private
 */
function logGamma(x) {
  var COF = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  var g = 7;
  if (x < 0.5) {
    // Reflection formula for completeness (not hit by factorial use).
    return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  }
  x -= 1;
  var a = COF[0];
  var t = x + g + 0.5;
  for (var i = 1; i < g + 2; i++) a += COF[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/**
 * ln(n!).
 * @param {number} n - A non-negative integer.
 * @returns {number} ln(n!).
 * @private
 */
function logFactorial(n) { return logGamma(n + 1); }

/**
 * ln of the binomial coefficient C(n, k).
 * @param {number} n - Total.
 * @param {number} k - Chosen.
 * @returns {number} ln(C(n,k)), or -Infinity when out of range.
 * @private
 */
function logChoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * Hypergeometric upper-tail p-value: the probability of drawing **at least**
 * `overlap` members of a set of size `setSize` when drawing `querySize` items
 * from a universe of `universeSize` — the over-representation p-value.
 * @param {number} overlap - Observed hits (query ∩ set).
 * @param {number} querySize - Query set size (draws).
 * @param {number} setSize - Annotated set size (successes in the population).
 * @param {number} universeSize - Background size (population).
 * @returns {number} P(X ≥ overlap), clamped to [0, 1].
 * @public
 */
export function hypergeometricPValue(overlap, querySize, setSize, universeSize) {
  var maxHits = Math.min(querySize, setSize);
  if (overlap <= 0) return 1;
  if (overlap > maxHits) return 0;
  var denom = logChoose(universeSize, querySize);
  var sum = 0;
  for (var i = overlap; i <= maxHits; i++) {
    var logP = logChoose(setSize, i) + logChoose(universeSize - setSize, querySize - i) - denom;
    sum += Math.exp(logP);
  }
  return Math.max(0, Math.min(1, sum));
}

/**
 * Benjamini-Hochberg FDR-adjusted p-values (step-up), preserving input order.
 * @param {Array<number>} pValues - Raw p-values.
 * @returns {Array<number>} Adjusted p-values (q-values), aligned to the input.
 * @public
 */
export function benjaminiHochberg(pValues) {
  var m = pValues.length;
  if (!m) return [];
  var order = pValues.map(function (p, i) { return { p: p, i: i }; })
    .sort(function (a, b) { return a.p - b.p; });
  var adjusted = new Array(m);
  var running = 1;
  for (var rank = m - 1; rank >= 0; rank--) {
    var q = order[rank].p * m / (rank + 1);
    running = Math.min(running, q);
    adjusted[order[rank].i] = Math.max(0, Math.min(1, running));
  }
  return adjusted;
}

/**
 * Normalise a list of ids to a de-duplicated, trimmed, upper-cased set map
 * (gene symbols are matched case-insensitively).
 * @param {Array<string>} ids - Identifiers.
 * @returns {object} A map id→true.
 * @private
 */
function toSet(ids) {
  var set = Object.create(null);
  (ids || []).forEach(function (id) {
    var key = String(id).trim().toUpperCase();
    if (key) set[key] = true;
  });
  return set;
}

/**
 * Run over-representation analysis of a query set against annotated gene sets.
 *
 * @param {Array<string>} query - The query identifiers (e.g. selected genes).
 * @param {Array<{id: string, name?: string, genes: Array<string>}>} geneSets -
 *   The annotated sets (pathways) to test.
 * @param {object} [options] - Options.
 * @param {Array<string>} [options.universe] - The background id list. Defaults
 *   to the union of every gene set plus the query (a self-contained background).
 * @param {number} [options.minSetSize=1] - Skip sets smaller than this.
 * @param {number} [options.maxSetSize=Infinity] - Skip sets larger than this.
 * @returns {Array<object>} One result per tested set, FDR-ascending:
 *   `{id, name, setSize, overlap, genes, pValue, fdr, oddsRatio, enrichment}`.
 * @public
 */
export function enrich(query, geneSets, options) {
  options = options || {};
  var querySet = toSet(query);
  var queryKeys = Object.keys(querySet);

  // Background: the caller's universe, else the union of all sets + query.
  var universe = Object.create(null);
  if (options.universe && options.universe.length) {
    universe = toSet(options.universe);
  } else {
    (geneSets || []).forEach(function (gs) {
      (gs.genes || []).forEach(function (g) { universe[String(g).trim().toUpperCase()] = true; });
    });
    queryKeys.forEach(function (g) { universe[g] = true; });
  }
  var universeSize = Object.keys(universe).length;
  // The query restricted to the background (hits outside it do not count).
  var queryInUniverse = queryKeys.filter(function (g) { return universe[g]; });
  var querySize = queryInUniverse.length;

  var minSet = options.minSetSize == null ? 1 : options.minSetSize;
  var maxSet = options.maxSetSize == null ? Infinity : options.maxSetSize;

  var tested = [];
  (geneSets || []).forEach(function (gs) {
    var setKeys = Object.keys(toSet(gs.genes)).filter(function (g) { return universe[g]; });
    var setSize = setKeys.length;
    if (setSize < minSet || setSize > maxSet) return;
    var setMap = toSet(setKeys);
    var hits = queryInUniverse.filter(function (g) { return setMap[g]; });
    var overlap = hits.length;
    var pValue = hypergeometricPValue(overlap, querySize, setSize, universeSize);
    // Odds ratio from the 2×2 table (query × set membership), Haldane-corrected.
    var a = overlap, b = querySize - overlap, c = setSize - overlap,
      d = universeSize - querySize - setSize + overlap;
    var oddsRatio = ((a + 0.5) * (d + 0.5)) / ((b + 0.5) * (c + 0.5));
    // Fold enrichment vs. the fraction expected by chance.
    var expected = querySize * setSize / (universeSize || 1);
    tested.push({ id: gs.id, name: gs.name || gs.id, setSize: setSize, overlap: overlap,
      genes: hits.map(function (g) { return g; }), pValue: pValue, oddsRatio: oddsRatio,
      enrichment: expected ? overlap / expected : 0 });
  });

  var fdr = benjaminiHochberg(tested.map(function (r) { return r.pValue; }));
  tested.forEach(function (r, i) { r.fdr = fdr[i]; });
  tested.sort(function (a, b) { return a.fdr - b.fdr || a.pValue - b.pValue || b.overlap - a.overlap; });
  return tested;
}

/**
 * Shape enrichment results as a CanvasXpress data object for a results panel:
 * one row per pathway (sample), the significance score as the measure, with
 * overlap / set-size / FDR as annotations.
 * @param {Array<object>} results - Output of {@link enrich}.
 * @param {number} [top=20] - Keep the most significant `top` pathways.
 * @returns {object} A CanvasXpress data object (`y.smps` = pathways).
 * @public
 */
export function enrichmentToData(results, top) {
  var rows = (results || []).slice(0, top == null ? 20 : top);
  var smps = rows.map(function (r) { return r.name; });
  var score = rows.map(function (r) {
    return Math.round(1000 * (-Math.log(Math.max(r.fdr, 1e-300)) / Math.LN10)) / 1000;
  });
  return {
    y: { vars: ['negLog10FDR'], smps: smps, data: [score] },
    x: {
      Overlap: rows.map(function (r) { return r.overlap; }),
      SetSize: rows.map(function (r) { return r.setSize; }),
      FDR: rows.map(function (r) { return Number(r.fdr.toExponential(2)); })
    }
  };
}
