import * as assert from 'assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

/**
 * The status bar renders a family of custom icon-font glyphs (`$(ember-ready)`,
 * the `ember-think-*` sweep, the `ember-start-*` blink, `$(ember-disabled)`).
 * Several facts must line up or an icon renders as a blank box -- and only on a
 * user's machine, because `contributes.icons` is not validated at package time:
 *
 *   1. every id used in code == a contributed icon id,
 *   2. every contributed `fontPath` points at a real woff,
 *   3. the woff actually contains a glyph per contributed icon,
 *   4. the woff ships in the VSIX (that one is scripts/verify-vsix.mjs).
 *
 * The glyphs' internal shapes are verified once at authoring time and reproduced
 * by scripts/build-icon-font.mjs.
 *
 * Compiled to out/test/; `__dirname/../..` is the extension root.
 */
const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Decompress a woff's named table (handles per-table zlib compression). */
function woffTable(buf: Buffer, want: string): Buffer {
	assert.strictEqual(buf.subarray(0, 4).toString('latin1'), 'wOFF', 'not a woff');
	const numTables = buf.readUInt16BE(12);
	for (let i = 0; i < numTables; i++) {
		const e = 44 + i * 20;
		if (buf.subarray(e, e + 4).toString('latin1') !== want) {
			continue;
		}
		const offset = buf.readUInt32BE(e + 4);
		const compLength = buf.readUInt32BE(e + 8);
		const origLength = buf.readUInt32BE(e + 12);
		const raw = buf.subarray(offset, offset + compLength);
		return compLength === origLength ? raw : zlib.inflateSync(raw);
	}
	throw new Error(`woff has no ${want} table`);
}

/** Codepoints the woff's cmap (format 4) maps to a real (non-zero) glyph. */
function mappedCodepoints(file: string): Set<number> {
	const cmap = woffTable(fs.readFileSync(file), 'cmap');
	const numSub = cmap.readUInt16BE(2);
	const out = new Set<number>();
	for (let i = 0; i < numSub; i++) {
		const sub = cmap.readUInt32BE(8 + i * 8);
		if (cmap.readUInt16BE(sub) !== 4) {
			continue; // only need the BMP format-4 table our builder emits
		}
		const segX2 = cmap.readUInt16BE(sub + 6);
		const segCount = segX2 / 2;
		const ends = sub + 14;
		const starts = ends + segX2 + 2;
		const deltas = starts + segX2;
		const ranges = deltas + segX2;
		for (let s = 0; s < segCount; s++) {
			const end = cmap.readUInt16BE(ends + s * 2);
			const start = cmap.readUInt16BE(starts + s * 2);
			const delta = cmap.readUInt16BE(deltas + s * 2);
			const rangeOffset = cmap.readUInt16BE(ranges + s * 2);
			if (start === 0xffff) {
				continue;
			}
			for (let cp = start; cp <= end; cp++) {
				let gid: number;
				if (rangeOffset === 0) {
					gid = (cp + delta) & 0xffff;
				} else {
					const idx = ranges + s * 2 + rangeOffset + (cp - start) * 2;
					const g = cmap.readUInt16BE(idx);
					gid = g === 0 ? 0 : (g + delta) & 0xffff;
				}
				if (gid !== 0) {
					out.add(cp);
				}
			}
		}
	}
	return out;
}

suite('status bar icon font', () => {
	const icons: Record<string, { default?: { fontCharacter?: string; fontPath?: string } }> =
		pkg.contributes?.icons ?? {};
	const emberIds = Object.keys(icons).filter((k) => k.startsWith('ember-'));

	// bug guard: a contributed icon whose fontCharacter is not in the woff (typo'd
	// codepoint, or the font was not rebuilt after an icon was added) is a blank
	// box at runtime only -- contributes.icons is not validated at package time.
	test('every contributed ember icon maps to a real glyph in the woff', () => {
		assert.ok(emberIds.length >= 8, 'expected the full ember-* icon family');
		const fontPaths = new Set<string>();
		for (const id of emberIds) {
			const fontPath = icons[id].default?.fontPath;
			assert.ok(fontPath, `${id} needs a fontPath`);
			fontPaths.add(fontPath);
		}
		assert.strictEqual(fontPaths.size, 1, 'the whole family should share one woff');
		const mapped = mappedCodepoints(path.join(root, [...fontPaths][0]));
		for (const id of emberIds) {
			// fontCharacter is a hex escape like "\\E900".
			const hex = icons[id].default?.fontCharacter?.replace(/\\+/g, '');
			assert.ok(hex && /^[0-9a-fA-F]+$/.test(hex), `${id} has no hex fontCharacter`);
			assert.ok(
				mapped.has(parseInt(hex, 16)),
				`${id} (U+${hex}) is not a glyph in the woff; rerun build-icon-font`,
			);
		}
	});

	// bug guard: renaming an icon id on one side and not the other -- status.ts
	// naming an ember-* id package.json does not contribute -- is a silent box.
	test('every ember-* icon used in status.ts is contributed', () => {
		const src = fs.readFileSync(path.join(root, 'src', 'status.ts'), 'utf8');
		const contributed = new Set(Object.keys(icons));
		const used = [...new Set([...src.matchAll(/ember-[a-z0-9-]+/g)].map((m) => m[0]))];
		assert.ok(used.length > 0, 'expected status.ts to reference ember-* icons');
		for (const id of used) {
			assert.ok(
				contributed.has(id),
				`status.ts uses ${id} but package.json does not contribute it`,
			);
		}
	});
});
