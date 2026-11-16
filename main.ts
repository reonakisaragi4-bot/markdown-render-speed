// Driver for the markdown-render-speed-02 entry. It renders every case in
// cases.json with parse() from parse.js and writes the resulting HTML
// strings, in the cases' order, to html.json. Node 22, stdlib only; run
// with `node main.ts` (the harness sets MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR, defaulting to /input and /output).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;
const html: string[] = new Array(cases.length);
for (let k = 0; k < cases.length; k++) {
  html[k] = parse(cases[k].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
