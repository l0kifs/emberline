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
});
