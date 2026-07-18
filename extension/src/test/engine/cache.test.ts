/**
 * Ported from server/tests/test_engine.py::TestCache and ::TestContextKey.
 *
 * House style: every test names the bug it guards against.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CompletionCache, contextKey } from '../../engine/cache';

describe('completion cache', () => {
	it('accounts hits and misses', () => {
		const c = new CompletionCache(4);
		assert.equal(c.get('k'), undefined);
		c.put('k', 'v');
		assert.equal(c.get('k'), 'v');
		assert.deepEqual([c.hits, c.misses], [1, 1]);
	});

	it('evicts the least recently used', () => {
		const c = new CompletionCache(2);
		c.put('a', '1');
		c.put('b', '2');
		c.get('a'); // 'a' is now the most recent, so 'b' should go first
		c.put('c', '3');
		assert.equal(c.get('a'), '1');
		assert.equal(c.get('b'), undefined);
		assert.equal(c.size, 2);
	});

	it('does not grow when reinserting an existing key', () => {
		const c = new CompletionCache(2);
		c.put('a', '1');
		c.put('a', '2');
		assert.equal(c.size, 1);
		assert.equal(c.get('a'), '2');
	});
});

describe('context key', () => {
	it('is stable for the same context', () => {
		assert.equal(contextKey('p', 's', 'e', 'd'), contextKey('p', 's', 'e', 'd'));
	});

	for (const args of [
		['P', 's', 'e', 'd'],
		['p', 'S', 'e', 'd'],
		['p', 's', 'E', 'd'], // different extra context must not collide
		['p', 's', 'e', 'D'], // nor different sampling params
	] as Array<[string, string, string, string]>) {
		it(`changes when a component changes: ${args.join(',')}`, () => {
			assert.notEqual(contextKey(...args), contextKey('p', 's', 'e', 'd'));
		});
	}

	it('does not make field boundaries ambiguous', () => {
		// Without a separator, ("ab","c") and ("a","bc") would hash identically.
		assert.notEqual(contextKey('ab', 'c', 'e', 'd'), contextKey('a', 'bc', 'e', 'd'));
	});

	it('distinguishes lone surrogates', () => {
		// The port bug this guards: Buffer.from(s, 'utf8') maps every lone
		// surrogate to U+FFFD, so two different prefixes would collide and serve
		// each other's completions. The extension slices the document by offset, so
		// a cursor landing inside a surrogate pair really does produce these.
		const a = '\ud83d'; // high surrogate of an emoji, alone
		const b = '\ude00'; // low surrogate of the same emoji, alone
		assert.notEqual(contextKey(a, 's', 'e', 'd'), contextKey(b, 's', 'e', 'd'));
		assert.notEqual(contextKey(a, 's', 'e', 'd'), contextKey('�', 's', 'e', 'd'));
	});
});
