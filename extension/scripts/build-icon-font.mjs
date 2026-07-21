#!/usr/bin/env node
/**
 * Generates `media/emberline-icons.woff` — the status bar glyph family.
 *
 * VS Code's status bar can only render a themed codicon glyph, never a raster
 * image, so `icon.png` becomes a status-bar mark by shipping a one-colour icon
 * font (contributed via `contributes.icons`). The design (a Ready mark plus per
 * state variants) is documented and previewed in `docs/design/status-icon-design.html`.
 *
 * The mark: two hollow "code" lines, a third line lit from the right by vertical
 * strokes that build to a solid end, and a filled rounded-rectangle cursor split
 * off that end. State variants:
 *   ember-ready              line 3 partly lit
 *   ember-think-1..4         the fill swept right→left (animation frames)
 *   ember-start-on/-off      all lines dark, cursor on/off (blink frames)
 *   ember-disabled           hollow lines + hollow cursor + a slash
 * Error reuses ember-ready with an errorBackground pill. The extension animates
 * by swapping the frame glyphs on a timer (see status.ts); ~spin is VS Code's
 * only built-in animation and does not fit this mark.
 *
 * Font metrics mirror codicon.ttf (ascent = unitsPerEm = 1000, descent = 0) so the
 * glyph sits on the line like the built-in icons. Filled outlines only: hollow
 * shapes are rings (outer contour + reversed inner contour) so the non-zero fill
 * rule leaves a real hole. Deterministic (svg2ttf ts:0): unchanged input yields a
 * byte-identical woff.
 *
 *   npm run build-icon-font   # needs Node 22 (svg-pathdata); see .nvmrc
 *
 * The output woff is committed; this script reproduces it. Keep the CODEPOINTS in
 * sync with package.json's `contributes.icons` fontCharacters and status.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';
import svg2ttf from 'svg2ttf';
import ttf2woff from 'ttf2woff';

const dir = path.dirname(fileURLToPath(import.meta.url));
const outWoff = path.join(dir, '..', 'media', 'emberline-icons.woff');

// ---- design geometry (the coordinate space of docs/design/status-icon-design.html) ----
const LEFT = 18;
const RC = 8;                    // line half-thickness (outer)
const SW = 4.6;                  // hollow line stroke width (bolder = thicker outline)
const CY = [20, 48, 76];         // line centres
const X2 = [98, 64, 88];         // line right ends
const CUR = { x: 106, w: 15, cy: 76, h: 26, r: 4 }; // cursor (tall rounded rect)
const HH = RC - 1.4;             // vertical-stroke half height
const SOLID = 74;                // line 3 solid from here to the end
const READY_FILL_LEFT = 50;      // line 3 fill starts here in Ready
// thinking sweep: how far left the fill reaches, per frame (right→left, then loops).
// Frame 1 is a hair past READY_FILL_LEFT so entering "thinking" from "ready" grows
// rather than dips, and the sweep is monotonic.
const THINK_FILL_LEFT = [48, 40, 30, 20];

// ---- map design space -> the em ----
// The mark (design bbox x[10..121] y[12..89]) is ~1.44:1 wide, so fitting it to
// the em WIDTH would leave it short and it renders small next to square codicons.
// Instead fill the em HEIGHT (~90%); the glyph then ends up wider than the em, so
// the viewBox widens to match and the advance width contains the ink (no overlap
// with neighbours). Font metrics still key off the 1000-unit em height.
const EM = 1000;
const V_MARGIN = 100; // em units of vertical breathing room (top+bottom total)
const BBOX = { x0: 10, x1: 121, y0: 12, y1: 89 };
const S = (EM - V_MARGIN) / (BBOX.y1 - BBOX.y0);
const VBW = Math.round((BBOX.x1 - BBOX.x0) * S + V_MARGIN);
const CXc = (BBOX.x0 + BBOX.x1) / 2;
const CYc = (BBOX.y0 + BBOX.y1) / 2;
const X = (x) => +((x - CXc) * S + VBW / 2).toFixed(1);
const Y = (y) => +((y - CYc) * S + EM / 2).toFixed(1);
const R = (r) => +(r * S).toFixed(1);

// forward (CW in screen space) = solid; reverse (CCW) = hole. The non-zero rule
// then fills solids and subtracts holes, regardless of svgicons2svgfont's y-flip.
const stadFwd = (x1, x2, cy, r) =>
	`M${X(x1)} ${Y(cy - r)}L${X(x2)} ${Y(cy - r)}A${R(r)} ${R(r)} 0 0 1 ${X(x2)} ${Y(cy + r)}` +
	`L${X(x1)} ${Y(cy + r)}A${R(r)} ${R(r)} 0 0 1 ${X(x1)} ${Y(cy - r)}Z`;
const stadRev = (x1, x2, cy, r) =>
	`M${X(x1)} ${Y(cy - r)}A${R(r)} ${R(r)} 0 0 0 ${X(x1)} ${Y(cy + r)}L${X(x2)} ${Y(cy + r)}` +
	`A${R(r)} ${R(r)} 0 0 0 ${X(x2)} ${Y(cy - r)}L${X(x1)} ${Y(cy - r)}Z`;
const rrectFwd = (x, y, w, h, r) =>
	`M${X(x + r)} ${Y(y)}L${X(x + w - r)} ${Y(y)}A${R(r)} ${R(r)} 0 0 1 ${X(x + w)} ${Y(y + r)}` +
	`L${X(x + w)} ${Y(y + h - r)}A${R(r)} ${R(r)} 0 0 1 ${X(x + w - r)} ${Y(y + h)}` +
	`L${X(x + r)} ${Y(y + h)}A${R(r)} ${R(r)} 0 0 1 ${X(x)} ${Y(y + h - r)}` +
	`L${X(x)} ${Y(y + r)}A${R(r)} ${R(r)} 0 0 1 ${X(x + r)} ${Y(y)}Z`;
const rrectRev = (x, y, w, h, r) =>
	`M${X(x + r)} ${Y(y)}A${R(r)} ${R(r)} 0 0 0 ${X(x)} ${Y(y + r)}L${X(x)} ${Y(y + h - r)}` +
	`A${R(r)} ${R(r)} 0 0 0 ${X(x + r)} ${Y(y + h)}L${X(x + w - r)} ${Y(y + h)}` +
	`A${R(r)} ${R(r)} 0 0 0 ${X(x + w)} ${Y(y + h - r)}L${X(x + w)} ${Y(y + r)}` +
	`A${R(r)} ${R(r)} 0 0 0 ${X(x + w - r)} ${Y(y)}L${X(x + r)} ${Y(y)}Z`;

const ring = (i) => stadFwd(LEFT, X2[i], CY[i], RC) + stadRev(LEFT, X2[i], CY[i], RC - SW);
const cursorSolid = () => rrectFwd(CUR.x, CUR.cy - CUR.h / 2, CUR.w, CUR.h, CUR.r);
const cursorHollow = () =>
	rrectFwd(CUR.x, CUR.cy - CUR.h / 2, CUR.w, CUR.h, CUR.r) +
	rrectRev(CUR.x + 4, CUR.cy - CUR.h / 2 + 4, CUR.w - 8, CUR.h - 8, Math.max(1, CUR.r - 2));
const solidEnd = () => stadFwd(SOLID, X2[2], CY[2], RC - 1);

/** Vertical strokes filling line 3 from x0 to SOLID, denser toward the right. */
function hatch(x0) {
	let out = '', x = x0;
	while (x <= SOLID + 0.01) {
		const t = Math.min(1, (x - x0) / (SOLID - x0));
		const w = 1.7 + Math.pow(t, 1.4) * 2.6; // stroke width grows
		out += rrectFwd(x - w / 2, CY[2] - HH, w, 2 * HH, w / 2);
		x += 1.6 + 4.4 * Math.pow(1 - t, 1.7); // gap shrinks toward the right
	}
	return out;
}

/** A thick diagonal bar (parallelogram), CW so it stays solid over everything. */
function slash() {
	const a = { x: 12, y: 12 }, b = { x: 122, y: 86 }, hw = 4.2;
	const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
	const px = (-dy / len) * hw, py = (dx / len) * hw;
	const p = [
		[a.x + px, a.y + py], [b.x + px, b.y + py],
		[b.x - px, b.y - py], [a.x - px, a.y - py],
	];
	return `M${X(p[0][0])} ${Y(p[0][1])}L${X(p[1][0])} ${Y(p[1][1])}` +
		`L${X(p[2][0])} ${Y(p[2][1])}L${X(p[3][0])} ${Y(p[3][1])}Z`;
}

const litLine3 = (fillLeft) => ring(2) + hatch(fillLeft) + solidEnd();

// ---- glyphs: id -> codepoint + path data. Keep in sync with package.json + status.ts. ----
const GLYPHS = [
	{ name: 'ember-ready',     cp: 0xe900, d: ring(0) + ring(1) + litLine3(READY_FILL_LEFT) + cursorSolid() },
	{ name: 'ember-think-1',   cp: 0xe901, d: ring(0) + ring(1) + litLine3(THINK_FILL_LEFT[0]) + cursorSolid() },
	{ name: 'ember-think-2',   cp: 0xe902, d: ring(0) + ring(1) + litLine3(THINK_FILL_LEFT[1]) + cursorSolid() },
	{ name: 'ember-think-3',   cp: 0xe903, d: ring(0) + ring(1) + litLine3(THINK_FILL_LEFT[2]) + cursorSolid() },
	{ name: 'ember-think-4',   cp: 0xe904, d: ring(0) + ring(1) + litLine3(THINK_FILL_LEFT[3]) + cursorSolid() },
	{ name: 'ember-start-on',  cp: 0xe905, d: ring(0) + ring(1) + ring(2) + cursorSolid() },
	{ name: 'ember-start-off', cp: 0xe906, d: ring(0) + ring(1) + ring(2) },
	{ name: 'ember-disabled',  cp: 0xe907, d: ring(0) + ring(1) + ring(2) + cursorHollow() + slash() },
];

function glyphStream(g) {
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VBW} ${EM}" width="${VBW}" height="${EM}">` +
		`<path d="${g.d}"/></svg>`;
	const s = Readable.from([svg]);
	s.metadata = { unicode: [String.fromCodePoint(g.cp)], name: g.name };
	return s;
}

function svgFont() {
	return new Promise((resolve, reject) => {
		const chunks = [];
		const stream = new SVGIcons2SVGFontStream({
			fontName: 'emberline',
			fontHeight: 1000,
			descent: 0,
			normalize: false,
			centerHorizontally: false,
			log: () => {},
		});
		stream.on('data', (c) => chunks.push(c.toString()));
		stream.on('end', () => resolve(chunks.join('')));
		stream.on('error', reject);
		for (const g of GLYPHS) {
			stream.write(glyphStream(g));
		}
		stream.end();
	});
}

const ttf = svg2ttf(await svgFont(), { description: 'Emberline status bar icons', ts: 0 });
const woff = ttf2woff(new Uint8Array(ttf.buffer));
fs.mkdirSync(path.dirname(outWoff), { recursive: true });
fs.writeFileSync(outWoff, Buffer.from(woff.buffer));
console.log(
	`wrote ${path.relative(dir, outWoff)} (${Buffer.from(woff.buffer).length} bytes, ${GLYPHS.length} glyphs)`,
);
