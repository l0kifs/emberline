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
});
