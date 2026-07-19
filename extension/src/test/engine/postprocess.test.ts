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
});
