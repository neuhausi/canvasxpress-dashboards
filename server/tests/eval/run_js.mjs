import { validateSpec } from '../../../src/validateSpec.js';
import fs from 'fs';
const corpus = JSON.parse(fs.readFileSync(new URL('./specs_corpus.json', import.meta.url)));
const out = {};
for (const c of corpus) { const r = validateSpec(c.spec); out[c.name] = { valid: r.valid, errors: r.errors }; }
console.log(JSON.stringify(out, null, 1));
