/**
 * P4: gene/sample set selection linkage over the shipped cross-source marking.
 * Proves a gene selection in the heatmap (variables) marks the same genes in
 * the companion stats panel (samples), keyed gene-to-gene across axes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { hasRelationships, relationGraph, translateMarks } from '../src/marking.js';
import { validateSpec } from '../src/validateSpec.js';

var spec = JSON.parse(fs.readFileSync(new URL('../examples/gene-set-linkage.spec.json', import.meta.url), 'utf8'));
var dataOf = function (ref) { return spec.data[ref].value; };

test('gene-set-linkage: the example spec is valid and declares a relationship', function () {
  assert.equal(validateSpec(spec).valid, true);
  assert.ok(hasRelationships(spec));
});

test('gene-set-linkage: selecting genes in the heatmap (vars) marks the same genes in stats (smps)', function () {
  var graph = relationGraph(spec);
  var picked = ['TP53', 'MYC', 'KRAS'];               // gene rows clicked in the heatmap
  var marks = translateMarks('expression', picked, graph, dataOf);
  assert.deepEqual((marks.geneStats || []).slice().sort(), picked.slice().sort());
});

test('gene-set-linkage: the link is bidirectional (selecting in stats marks the heatmap genes)', function () {
  var graph = relationGraph(spec);
  var marks = translateMarks('geneStats', ['EGFR', 'BRAF'], graph, dataOf);
  assert.deepEqual((marks.expression || []).slice().sort(), ['BRAF', 'EGFR']);
});
