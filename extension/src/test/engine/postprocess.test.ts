/** Ported from server/tests/test_postprocess.py. */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { trimCompletion } from '../../engine/postprocess';

describe('trim completion', () => {
	it('passes through a normal completion', () => {
		assert.equal(trimCompletion('return a + b', '\n'), 'return a + b');
	});

	it('drops whitespace-only output', () => {
		// Ghost text made of whitespace swallows the Tab key for nothing.
		assert.equal(trimCompletion('   \n  ', ''), '');
		assert.equal(trimCompletion('', ''), '');
	});

	it('strips overlap with the suffix', () => {
		// Cursor sits before ')', model helpfully emits ')' too -> accepting yields '))'.
		assert.equal(trimCompletion('foo(a, b)', ')\n'), 'foo(a, b');
	});

	it('strips the longest overlap', () => {
		assert.equal(trimCompletion('value\n}\n', '\n}\nrest'), 'value');
	});

	it('leaves non-overlapping output alone', () => {
		assert.equal(trimCompletion('xyz', 'abc'), 'xyz');
	});

	it('strips trailing newlines', () => {
		assert.equal(trimCompletion('done\n\n\n', ''), 'done');
	});

	it('can empty the completion entirely', () => {
		// The model produced only what already follows the cursor: nothing to offer.
		assert.equal(trimCompletion(')', ')'), '');
	});

	// Distinct code units throughout, so an overlap can only match at its true
	// length -- a repeating filler like 'a'.repeat(n) matches at every offset and
	// would hide an off-by-one in the scan window.
	const distinct = (n: number): string =>
		Array.from({ length: n }, (_, i) => String.fromCharCode(0x100 + i)).join('');

	it('strips a large overlap', () => {
		const dup = distinct(200);
		assert.equal(trimCompletion(`HEAD${dup}`, `${dup}tail`), 'HEAD');
	});

	it('strips an overlap past the old 200-char scan limit', () => {
		// The scan used to cap at suffix.slice(0, 200), and the cap was a cliff: a
		// 201-char overlap matched at no length and came back whole. The scan is
		// uncapped now, so an overlap of any length is stripped.
		const dup = distinct(201);
		assert.equal(trimCompletion(`HEAD${dup}`, `${dup}tail`), 'HEAD');

		// Well past the old limit, to be sure it is not a shifted-by-one artefact.
		const big = distinct(5000);
		assert.equal(trimCompletion(`HEAD${big}`, `${big}tail`), 'HEAD');
	});

	it('strips an overlap of a single char', () => {
		// The minimum the scan can find; `size > 0` must not be `size > 1`.
		assert.equal(trimCompletion('foo)', ')\nbar'), 'foo');
	});

	it('strips a suffix shorter than the completion', () => {
		// The scan is bounded by min(text.length, head.length); overrunning the
		// shorter of the two would slice past the string.
		assert.equal(trimCompletion('abcdef', 'def'), 'abc');
	});

	it('empties a completion equal to the head of the suffix', () => {
		assert.equal(trimCompletion('abc', 'abcdef'), '');
	});

	it('returns the completion unchanged for an empty suffix', () => {
		assert.equal(trimCompletion('abc', ''), 'abc');
	});

	it('returns nothing for an empty completion', () => {
		assert.equal(trimCompletion('', 'abc'), '');
	});

	it('returns nothing for a completion of only newlines', () => {
		assert.equal(trimCompletion('\n\n\n', 'abc'), '');
	});

	it('strips the suffix overlap before the trailing newlines', () => {
		// Order guard: newline-stripping first would expose 'c' as an overlap with
		// the suffix and eat a char the model actually meant to emit ('ab').
		assert.equal(trimCompletion('abc\n', 'c!'), 'abc');
	});

	it('compares by code unit when an astral char straddles the overlap', () => {
		// Documented tradeoff: the scan is UTF-16 code units, so a suffix beginning
		// with a lone low surrogate strips half an emoji. It must not throw, and it
		// must not be "fixed" with Array.from -- that costs an allocation per
		// keystroke on the hottest path for a case the editor cannot produce.
		const out = trimCompletion('a😀', '\ude00b');
		assert.equal(out, 'a\ud83d');
		assert.equal(out.length, 2);
	});

	it('strips a whole emoji that overlaps the suffix', () => {
		assert.equal(trimCompletion('foo😀', '😀bar'), 'foo');
	});
});
