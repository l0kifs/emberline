/**
 * New in the TS port: `tokens`/`similarity` were duplicated inside ring.py and
 * are now shared with the example store, so they get their own guards.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { similarity, tokens } from '../../engine/tokens';

describe('tokens', () => {
	it('keeps identifier-ish runs of at least three characters', () => {
		assert.deepEqual([...tokens('const ab = foo_bar(x1)')], ['const', 'foo_bar']);
	});

	it('does not leak regex state between calls', () => {
		// The bug this guards: a module-level /g regex used with .exec or .test
		// carries lastIndex across calls, so every other call returns fewer tokens.
		const text = 'alpha beta gamma';
		assert.deepEqual([...tokens(text)], [...tokens(text)]);
	});

	it('deduplicates', () => {
		assert.equal(tokens('alpha alpha alpha').size, 1);
	});
});

describe('similarity', () => {
	it('is zero when either side is empty', () => {
		assert.equal(similarity(new Set(), new Set(['a'])), 0);
		assert.equal(similarity(new Set(['a']), new Set()), 0);
	});

	it('is one for identical sets', () => {
		assert.equal(similarity(new Set(['a', 'b']), new Set(['a', 'b'])), 1);
	});

	it('is Jaccard, not overlap count', () => {
		// {a,b} vs {b,c}: intersection 1, union 3.
		assert.equal(similarity(new Set(['a', 'b']), new Set(['b', 'c'])), 1 / 3);
	});

	it('is symmetric regardless of which side is smaller', () => {
		const a = new Set(['a', 'b', 'c', 'd']);
		const b = new Set(['c', 'd']);
		assert.equal(similarity(a, b), similarity(b, a));
	});
});
