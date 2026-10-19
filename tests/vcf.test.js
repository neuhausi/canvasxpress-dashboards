/**
 * P5: minimal VCF reader. Run with `node --test`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVcf, vcfToData, variantsPerChromosome } from '../src/vcf.js';

var VCF = [
  '##fileformat=VCFv4.2',
  '##INFO=<ID=DP,Number=1,Type=Integer,Description="Depth">',
  '##INFO=<ID=GENE,Number=1,Type=String,Description="Gene">',
  '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\tFORMAT\tS1\tS2',
  '1\t10583\trs58108140\tG\tA\t99.5\tPASS\tDP=120;GENE=TP53;DB\tGT:DP\t0/1:60\t1/1:60',
  '1\t13302\t.\tC\tT\t.\tLowQual\tDP=8\tGT:DP\t0/0:4\t0/1:4',
  '2\t47702\trs71232\tA\tG\t250\tPASS\tDP=200;GENE=KRAS\tGT:DP\t1/1:100\t0/1:100'
].join('\n');

test('parseVcf: meta, samples, and typed records', function () {
  var p = parseVcf(VCF);
  assert.equal(p.meta.length, 3);
  assert.deepEqual(p.samples, ['S1', 'S2']);
  assert.equal(p.records.length, 3);
  var r0 = p.records[0];
  assert.equal(r0.CHROM, '1');
  assert.equal(r0.POS, 10583);          // numeric
  assert.equal(r0.QUAL, 99.5);          // numeric
  assert.equal(r0.INFO.DP, '120');
  assert.equal(r0.INFO.GENE, 'TP53');
  assert.equal(r0.INFO.DB, true);        // bare flag
  assert.equal(r0.samples.S1.GT, '0/1');
  assert.equal(r0.samples.S2.GT, '1/1');
  assert.equal(p.records[1].QUAL, null); // '.' → null
});

test('vcfToData: variants as rows, POS/QUAL measures, annotations + lifted INFO', function () {
  var data = vcfToData(parseVcf(VCF), { info: ['GENE'] });
  assert.deepEqual(data.y.vars, ['POS', 'QUAL']);
  assert.deepEqual(data.y.smps, ['rs58108140', '1:13302', 'rs71232']);  // ID or CHROM:POS
  assert.deepEqual(data.y.data[0], [10583, 99.5]);
  assert.deepEqual(data.x.CHROM, ['1', '1', '2']);
  assert.deepEqual(data.x.GENE, ['TP53', null, 'KRAS']);
});

test('variantsPerChromosome: counts in first-seen order', function () {
  var data = variantsPerChromosome(parseVcf(VCF));
  assert.deepEqual(data.y.smps, ['1', '2']);
  assert.deepEqual(data.y.data[0], [2, 1]);
});

test('parseVcf: tolerates empty input', function () {
  var p = parseVcf('');
  assert.deepEqual(p.records, []);
  assert.deepEqual(p.samples, []);
});
