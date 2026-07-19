/**
 * New in the TS port: ring.py had no tests (the I/O half was uncovered), and the
 * port has two traps that only show up against a real filesystem.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { RingContext } from '../../engine/ring';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-ring-'));

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function write(name: string, content: string | Buffer): string {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, content);
	return p;
}

const PREFIX = 'function computeTotals(order) {';
const CURRENT = path.join(tmp, 'current.ts');

/** ASCII body of exactly `bytes` bytes that still scores against PREFIX. */
function sizedBody(bytes: number): string {
	const unit = 'computeTotals order sum\n';
	const whole = unit.repeat(Math.floor(bytes / unit.length));
	return whole + 'a'.repeat(bytes - whole.length);
}

describe('ring context', () => {
	it('ranks chunks from other open files against the cursor', () => {
		const related = write('related.ts', 'function computeTotals(order) { return order.sum; }');
		const unrelated = write('unrelated.ts', 'const zzz = 1;\nconst yyy = 2;\n');
		const ring = new RingContext();

		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [unrelated, related],
		});

		assert.equal(out[0].filename, 'related.ts');
	});

	it('excludes the current file', () => {
		const current = write('self.ts', 'function computeTotals(order) { return order.sum; }');
		const ring = new RingContext();
		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: current,
			openPaths: [current],
		});
		assert.deepEqual(out, []);
	});

	it('skips binary files instead of chunking replacement characters', () => {
		// The port bug this guards: fs.readFileSync(p, 'utf8') does NOT throw on
		// invalid UTF-8 the way Python's read_text(errors="strict") did -- it
		// substitutes U+FFFD, so a binary file would be chunked into garbage and fed
		// to the model as cross-file context.
		const binary = write(
			'blob.bin',
			Buffer.concat([
				Buffer.from('computeTotals order sum '.repeat(8), 'utf8'),
				Buffer.from([0xff, 0xfe, 0xff, 0xfe]),
			]),
		);
		const ring = new RingContext();
		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [binary],
		});
		assert.deepEqual(out, []);
	});

	it('skips files over the size cap', () => {
		const big = write('big.ts', 'computeTotals order sum\n'.repeat(40_000));
		assert.ok(fs.statSync(big).size > 512 * 1024);
		const ring = new RingContext();
		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [big],
		});
		assert.deepEqual(out, []);
	});

	it('tolerates a path that does not exist', () => {
		const ring = new RingContext();
		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [path.join(tmp, 'gone.ts')],
		});
		assert.deepEqual(out, []);
	});

	it('re-reads a file after it changes on disk', () => {
		const p = write('mutable.ts', 'const computeTotals = 1;\n');
		const ring = new RingContext();
		const args = {
			prefix: 'computeTotals reconcileLedger',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [p],
		};
		assert.match(ring.build(args)[0].text, /computeTotals/);

		// Mtime is compared in nanoseconds; a same-millisecond rewrite must still
		// invalidate, which is why the port reads stat with { bigint: true }.
		fs.writeFileSync(p, 'const reconcileLedger = 2;\n');
		assert.match(ring.build(args)[0].text, /reconcileLedger/);
	});

	it('honours maxChunks', () => {
		const body = Array.from({ length: 40 }, (_, i) => `function computeTotals${i}() {}`).join(
			'\n',
		);
		const p = write('many.ts', body);
		const ring = new RingContext({ maxChunks: 2, chunkLines: 1 });
		const out = ring.build({
			prefix: 'function computeTotals(order) {',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [p],
		});
		assert.equal(out.length, 2);
	});

	it('returns nothing when the cursor context has no tokens', () => {
		const p = write('other.ts', 'const computeTotals = 1;\n');
		const ring = new RingContext();
		const out = ring.build({
			prefix: '  ){;',
			currentPath: path.join(tmp, 'current.ts'),
			openPaths: [p],
		});
		assert.deepEqual(out, []);
	});

	it('includes a file of exactly the size cap', () => {
		// The check is `stat.size > MAX_FILE_BYTES`, strictly greater. This is the
		// lower half of the boundary pair: exactly 512 KiB must still be read.
		const p = write('cap-exact.ts', sizedBody(512 * 1024));
		assert.equal(fs.statSync(p).size, 512 * 1024);
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.ok(out.length > 0);
	});

	it('skips a file one byte over the size cap', () => {
		const p = write('cap-over.ts', `${sizedBody(512 * 1024)}b`);
		assert.equal(fs.statSync(p).size, 512 * 1024 + 1);
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.deepEqual(out, []);
	});

	it('returns nothing when maxChunks is 0', () => {
		const p = write('zero-chunks.ts', 'function computeTotals(order) { return order.sum; }\n');
		const out = new RingContext({ maxChunks: 0 }).build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.deepEqual(out, []);
	});

	it('returns only the highest-scoring chunk when maxChunks is 1', () => {
		const near = write('near.ts', 'function computeTotals(order) { return order.sum; }\n');
		const far = write('far.ts', 'const zzzUnrelated = computeTotals;\n');
		const out = new RingContext({ maxChunks: 1 }).build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [far, near],
		});
		assert.equal(out.length, 1);
		assert.equal(out[0].filename, 'near.ts');
	});

	it('emits one chunk per non-blank line when chunkLines is 1', () => {
		const p = write(
			'per-line.ts',
			'computeTotals alpha\n\ncomputeTotals beta\n   \ncomputeTotals gamma\n',
		);
		const out = new RingContext({ chunkLines: 1 }).build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.deepEqual(
			out.map((c) => c.text).sort(),
			['computeTotals alpha', 'computeTotals beta', 'computeTotals gamma'],
		);
	});

	it('emits no trailing chunk when the line count is a multiple of chunkLines', () => {
		// Splitting on newline leaves a final empty element for a file ending in one,
		// which would otherwise become a blank chunk shipped as cross-file context.
		const p = write(
			'aligned.ts',
			'computeTotals a\ncomputeTotals b\ncomputeTotals c\ncomputeTotals d\n',
		);
		const out = new RingContext({ chunkLines: 2 }).build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.equal(out.length, 2);
		assert.ok(out.every((c) => c.text.trim() !== ''));
	});

	it('contributes nothing from an empty file', () => {
		const p = write('void.ts', '');
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.deepEqual(out, []);
	});

	it('contributes nothing from a whitespace-only file', () => {
		const p = write('blank.ts', '   \n\t\n\n');
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p],
		});
		assert.deepEqual(out, []);
	});

	it('returns nothing when no files are open', () => {
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [],
		});
		assert.deepEqual(out, []);
	});

	it('emits a path listed twice in openPaths only once', () => {
		// A path open in two tab groups arrives twice; without dedupe each copy spent
		// an input_extra slot on byte-identical text. build() now skips a path it has
		// already seen, so the duplicate contributes nothing.
		const p = write('twice.ts', 'function computeTotals(order) { return order.sum; }\n');
		const out = new RingContext().build({
			prefix: PREFIX,
			currentPath: CURRENT,
			openPaths: [p, p],
		});
		assert.deepEqual(
			out.map((c) => c.filename),
			['twice.ts'],
		);
	});

	it('keeps openPaths order when scores tie', () => {
		// Array.prototype.sort is stable, which is what stops identically-scoring
		// chunks from shuffling between keystrokes and busting llama.cpp's KV cache.
		const body = 'function computeTotals(order) { return order.sum; }\n';
		const a = write('tie-a.ts', body);
		const b = write('tie-b.ts', body);
		const ring = new RingContext();
		assert.deepEqual(
			ring.build({ prefix: PREFIX, currentPath: CURRENT, openPaths: [a, b] }).map((c) => c.filename),
			['tie-a.ts', 'tie-b.ts'],
		);
		assert.deepEqual(
			ring.build({ prefix: PREFIX, currentPath: CURRENT, openPaths: [b, a] }).map((c) => c.filename),
			['tie-b.ts', 'tie-a.ts'],
		);
	});

	it('still ranks every open file once the file cache has evicted', () => {
		// maxFiles is 32, so 33 open files overflow the LRU on a single build. The
		// evicted entries must be re-read, not silently dropped from the ranking.
		const paths = Array.from({ length: 33 }, (_, i) =>
			write(`lru-${i}.ts`, `function computeTotals(order) { return order.sum${i}; }\n`),
		);
		const ring = new RingContext({ maxChunks: 100 });
		const args = { prefix: PREFIX, currentPath: CURRENT, openPaths: paths };
		assert.equal(ring.build(args).length, 33);
		assert.equal(ring.build(args).length, 33);
	});
});
