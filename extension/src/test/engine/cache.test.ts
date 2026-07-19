/**
 * Ported from server/tests/test_engine.py::TestCache and ::TestContextKey.
 *
 * House style: every test names the bug it guards against.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CompletionCache, contextKey, digest } from '../../engine/cache';

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

	it('evicts on the second key at a capacity of one', () => {
		// The smallest useful capacity: `size >= max` must fire at size 1, not 2.
		const c = new CompletionCache(1);
		c.put('a', '1');
		c.put('b', '2');
		assert.equal(c.size, 1);
		assert.equal(c.get('b'), '2');
		assert.equal(c.get('a'), undefined);
	});

	it('caches nothing at a capacity of zero', () => {
		// A non-positive capacity means caching off. The old put() evicted *before*
		// inserting, so on an empty map there was nothing to evict and the entry
		// landed anyway -- max: 0 held one entry instead of none. Now it stores none.
		const c = new CompletionCache(0);
		c.put('a', '1');
		assert.equal(c.size, 0);
		c.put('b', '2');
		assert.equal(c.size, 0);
		assert.equal(c.get('a'), undefined);
		assert.equal(c.get('b'), undefined);
	});

	it('evicts nothing while filling to exactly the capacity', () => {
		const c = new CompletionCache(3);
		c.put('a', '1');
		c.put('b', '2');
		c.put('c', '3');
		assert.equal(c.size, 3);
		assert.equal(c.get('a'), '1');
		assert.equal(c.get('b'), '2');
		assert.equal(c.get('c'), '3');
	});

	it('evicts exactly one entry on the put past the capacity', () => {
		const c = new CompletionCache(3);
		c.put('a', '1');
		c.put('b', '2');
		c.put('c', '3');
		c.put('d', '4');
		assert.equal(c.size, 3);
		assert.equal(c.get('a'), undefined);
	});

	it('evicts by recency of use, not by insertion order', () => {
		// The real LRU guard: a plain FIFO passes the eviction test above unchanged.
		// get() must move 'a' to the back so the untouched 'b' is what goes.
		const c = new CompletionCache(3);
		c.put('a', '1');
		c.put('b', '2');
		c.put('c', '3');
		c.get('a');
		c.put('d', '4');
		assert.equal(c.get('a'), '1');
		assert.equal(c.get('b'), undefined);
		assert.equal(c.size, 3);
	});

	it('counts a lookup of an evicted key as a miss', () => {
		// An eviction that left the entry unreachable but uncounted would make the
		// hit rate look fine while the cache silently thrashed.
		const c = new CompletionCache(1);
		c.put('a', '1');
		c.put('b', '2');
		assert.equal(c.get('a'), undefined);
		assert.deepEqual([c.hits, c.misses], [0, 1]);
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

	it('is stable for all-empty components', () => {
		// Degenerate but reachable: an empty document with no extra context. The key
		// must be a normal hash, not a throw or an empty string.
		const key = contextKey('', '', '', '');
		assert.equal(key, contextKey('', '', '', ''));
		assert.equal(key.length, 64);
	});
});

describe('extra digest', () => {
	it('is stable for an empty list', () => {
		assert.equal(digest([]), digest([]));
	});

	it('distinguishes an empty list from a list of one empty string', () => {
		// Boundary of the loop: zero parts writes nothing, one empty part still
		// writes its NUL. Collapsing them would let "no extra context" and "one
		// empty chunk" share a cache key.
		assert.notEqual(digest([]), digest(['']));
	});

	it('does not make chunk boundaries ambiguous', () => {
		// Same NUL-separator guard the contextKey test makes, for digest itself:
		// without it, two chunks and their concatenation would hash identically and
		// serve each other's completions.
		assert.notEqual(digest(['a', 'b']), digest(['ab']));
	});
});
