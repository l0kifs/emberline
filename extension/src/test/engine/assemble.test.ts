/**
 * New in the TS port: the Assembler was in the untested I/O half.
 *
 * It is the module the golden-context parity harness (docs/typescript-migration.md
 * §6) exercises hardest, so its invariants are worth pinning down first.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Assembler } from '../../engine/assemble';
import { DEFAULTS, type Settings } from '../../engine/config';
import type { Example, ExampleSource } from '../../engine/types';

function settings(over: Partial<Settings> = {}): Settings {
	return { ...DEFAULTS, ...over };
}

const noDeps = { ring: null, examples: null };

function exampleSource(hits: Example[]): ExampleSource {
	return { search: async () => hits };
}

/** Boundary-value helper: build with only the clamp settings that matter. */
async function clamp(over: Partial<Settings>, prefix: string, suffix: string) {
	const { req } = await new Assembler(settings(over), noDeps).build({
		prefix,
		suffix,
		languageId: 'typescript',
		path: '/tmp/x.ts',
		openPaths: [],
	});
	return req;
}

describe('assembler', () => {
	it('keeps the prefix tail and the suffix head', () => {
		const a = new Assembler(settings({ maxPrefixChars: 10, maxSuffixChars: 5 }), noDeps);
		return a
			.build({
				prefix: 'a'.repeat(100),
				suffix: 'b'.repeat(100),
				languageId: 'typescript',
				path: '/tmp/x.ts',
				openPaths: [],
			})
			.then(({ req }) => {
				assert.equal(req.prefix, 'a'.repeat(10));
				assert.equal(req.suffix, 'b'.repeat(5));
			});
	});

	it('digests the extra context, not just its presence', async () => {
		// The bug this guards: the digest feeds the cache key, so if it ignored
		// content a cache hit would serve a completion built from different
		// surrounding files.
		const a = new Assembler(settings(), { ring: null, examples: exampleSource([]) });
		const b = new Assembler(settings(), {
			ring: null,
			examples: exampleSource([{ prefix: 'x = ', completion: '1', languageId: 'py' }]),
		});
		const args = {
			prefix: 'p',
			suffix: 's',
			languageId: 'py',
			path: '/tmp/x.py',
			openPaths: [],
		};
		const [empty, filled] = await Promise.all([a.build(args), b.build(args)]);
		assert.notEqual(empty.extraDigest, filled.extraDigest);
	});

	it('survives a failing example store', async () => {
		// Invariant: retrieval is an enhancement; never fail a completion over it.
		const exploding: ExampleSource = {
			search: async () => {
				throw new Error('store is on fire');
			},
		};
		const logged: string[] = [];
		const a = new Assembler(settings(), {
			ring: null,
			examples: exploding,
			log: (m) => logged.push(m),
		});
		const { req } = await a.build({
			prefix: 'p',
			suffix: 's',
			languageId: 'py',
			path: '/tmp/x.py',
			openPaths: [],
		});
		assert.equal(req.prefix, 'p');
		assert.deepEqual(req.extra, []);
		assert.equal(logged.length, 1);
	});

	it('honours the enabled flags without needing the deps removed', async () => {
		const a = new Assembler(settings({ examplesEnabled: false }), {
			ring: null,
			examples: exampleSource([{ prefix: 'x = ', completion: '1', languageId: 'py' }]),
		});
		const { req } = await a.build({
			prefix: 'p',
			suffix: 's',
			languageId: 'py',
			path: '/tmp/x.py',
			openPaths: [],
		});
		assert.deepEqual(req.extra, []);
	});

	it('carries the sampling budget onto the infill request', async () => {
		const a = new Assembler(settings({ nPredict: 7, temperature: 0.42 }), noDeps);
		const { req } = await a.build({
			prefix: 'p',
			suffix: 's',
			languageId: 'py',
			path: '/tmp/x.py',
			openPaths: [],
		});
		assert.equal(req.n_predict, 7);
		assert.equal(req.temperature, 0.42);
	});

	it('passes a prefix of exactly the limit through untouched', async () => {
		const req = await clamp({ maxPrefixChars: 4 }, 'abcd', '');
		assert.equal(req.prefix, 'abcd');
	});

	it('truncates a prefix one char over the limit down to its tail', async () => {
		// The tail is the half that carries signal; a head-keeping clamp would hand
		// the model the text furthest from the cursor.
		const req = await clamp({ maxPrefixChars: 4 }, 'abcde', '');
		assert.equal(req.prefix, 'bcde');
	});

	it('leaves a prefix one char under the limit untouched', async () => {
		const req = await clamp({ maxPrefixChars: 4 }, 'abc', '');
		assert.equal(req.prefix, 'abc');
	});

	it('clamps the prefix to nothing at a limit of zero', async () => {
		// The bug this guards: the clamp was `slice(-maxPrefixChars)`, and -0 === 0,
		// so a limit of 0 returned the *entire* prefix instead of none of it.
		const req = await clamp({ maxPrefixChars: 0 }, 'abcd', '');
		assert.equal(req.prefix, '');
	});

	it('keeps exactly the last character at a prefix limit of one', async () => {
		const req = await clamp({ maxPrefixChars: 1 }, 'abcd', '');
		assert.equal(req.prefix, 'd');
	});

	it('clamps a negative prefix limit to nothing rather than keeping the head', async () => {
		// Same `slice(-n)` bug from the other side: a negative limit sliced from the
		// front, inverting the clamp into a head-keeping one. The prefix has to be
		// longer than the limit for the two to differ -- with a 4-char prefix the old
		// `slice(5)` also yielded '', and this test passed against the bug.
		const req = await clamp({ maxPrefixChars: -5 }, 'abcdefghij', '');
		assert.equal(req.prefix, '');
	});

	it('passes a suffix of exactly the limit through untouched', async () => {
		const req = await clamp({ maxSuffixChars: 4 }, '', 'abcd');
		assert.equal(req.suffix, 'abcd');
	});

	it('truncates a suffix one char over the limit down to its head', async () => {
		const req = await clamp({ maxSuffixChars: 4 }, '', 'abcde');
		assert.equal(req.suffix, 'abcd');
	});

	it('leaves a suffix one char under the limit untouched', async () => {
		const req = await clamp({ maxSuffixChars: 4 }, '', 'abc');
		assert.equal(req.suffix, 'abc');
	});

	it('clamps the suffix to nothing at a limit of zero', async () => {
		const req = await clamp({ maxSuffixChars: 0 }, '', 'abcd');
		assert.equal(req.suffix, '');
	});

	it('accepts empty prefix and suffix', async () => {
		const req = await clamp({ maxPrefixChars: 10, maxSuffixChars: 10 }, '', '');
		assert.equal(req.prefix, '');
		assert.equal(req.suffix, '');
	});

	it('truncates mid surrogate pair without throwing', async () => {
		// The clamp counts UTF-16 code units, so a boundary landing inside an astral
		// pair yields a lone surrogate rather than dropping or duplicating the char.
		// That is deliberate: contextKey hashes UTF-16LE precisely so lone surrogates
		// stay distinguishable instead of collapsing to U+FFFD.
		const req = await clamp({ maxPrefixChars: 2 }, '😀b', '');
		assert.equal(req.prefix.length, 2);
		assert.equal(req.prefix, '\ude00b');
	});
});
