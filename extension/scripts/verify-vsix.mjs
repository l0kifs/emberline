#!/usr/bin/env node
/**
 * Asserts a built VSIX contains what it must.
 *
 * Both failures this catches are invisible until a user hits them:
 *
 * - `dist/server.js` missing -> the extension installs, activates, and then
 *   cannot start a server. There is nothing to fall back to; the inference
 *   engine ships inside the package now.
 * - `bin/llama/llama-server` missing from a *targeted* build -> a VSIX that
 *   advertises a bundled engine and has none. This is the `.vscodeignore` trap
 *   documented in that file: excluding `bin/**` silently produces exactly this.
 *
 * Usage: node scripts/verify-vsix.mjs <file.vsix> [--expect-llama]
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';

const [vsix, ...flags] = process.argv.slice(2);
const expectLlama = flags.includes('--expect-llama');

if (!vsix || !fs.existsSync(vsix)) {
	console.error(`usage: node scripts/verify-vsix.mjs <file.vsix> [--expect-llama]`);
	process.exit(2);
}

// A VSIX is a zip. `unzip -Z1` lists entries without extracting.
let entries;
try {
	entries = execFileSync('unzip', ['-Z1', vsix], { encoding: 'utf8' }).split('\n');
} catch (err) {
	console.error(`could not read ${vsix}: ${err.message}`);
	process.exit(2);
}

const required = [
	'extension/dist/extension.js',
	'extension/dist/server.js',
	// The status bar's `$(ember-*)` glyph family. Missing -> the icons render as
	// blank boxes, but only on a user's machine; contributes.icons is not validated
	// at package time.
	'extension/media/emberline-icons.woff',
];
if (expectLlama) {
	required.push('extension/bin/llama/llama-server');
}

let failed = false;
for (const path of required) {
	const present = entries.includes(path);
	console.log(`${present ? 'ok  ' : 'MISSING'}  ${path}`);
	if (!present) {
		failed = true;
	}
}

// A stray `src/` or `.map` means .vscodeignore stopped working, which bloats the
// download without breaking anything -- worth reporting, not worth failing on.
const strays = entries.filter((e) => e.startsWith('extension/src/') || e.endsWith('.map'));
if (strays.length > 0) {
	console.warn(`warning: ${strays.length} entries that .vscodeignore should have excluded`);
	strays.slice(0, 5).forEach((s) => console.warn(`  ${s}`));
}

const size = (fs.statSync(vsix).size / 1024 / 1024).toFixed(1);
console.log(`${vsix}: ${entries.filter(Boolean).length} entries, ${size} MB`);

if (failed) {
	console.error(`\n${vsix} is missing required files; refusing to publish it.`);
	process.exit(1);
}
console.log('\nVSIX contents verified.');
