/**
 * New in the TS port: config.py was pydantic-settings, so its parsing was
 * upstream's problem. Now it is ours, and the env var names are a compatibility
 * surface -- anyone with EMBERLINE__* already exported expects them to keep working.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULTS, loadSettings } from '../../engine/config';

describe('settings', () => {
	it('defaults when the environment is empty', () => {
		const s = loadSettings({});
		assert.equal(s.port, 8011);
		assert.equal(s.llamaPreset, '--fim-qwen-1.5b-default');
		assert.equal(s.idleTimeoutS, 1800);
	});

	it('maps camelCase fields to the documented env names', () => {
		// These spellings are the compatibility surface with the Python server.
		const s = loadSettings({
			EMBERLINE__PORT: '9000',
			EMBERLINE__N_PREDICT: '64',
			EMBERLINE__T_MAX_PREDICT_MS: '500',
			EMBERLINE__TOP_P: '0.5',
			EMBERLINE__TOP_K: '10',
			EMBERLINE__LLAMA_STARTUP_TIMEOUT_S: '60',
			EMBERLINE__MAX_PREFIX_CHARS: '1024',
			EMBERLINE__EXAMPLES_TOP_K: '5',
			EMBERLINE__IDLE_TIMEOUT_S: '0',
			EMBERLINE__LLAMA_BINARY: '/opt/llama-server',
		});
		assert.equal(s.port, 9000);
		assert.equal(s.nPredict, 64);
		assert.equal(s.tMaxPredictMs, 500);
		assert.equal(s.topP, 0.5);
		assert.equal(s.topK, 10);
		assert.equal(s.llamaStartupTimeoutS, 60);
		assert.equal(s.maxPrefixChars, 1024);
		assert.equal(s.examplesTopK, 5);
		assert.equal(s.idleTimeoutS, 0);
		assert.equal(s.llamaBinary, '/opt/llama-server');
	});

	it('accepts the boolean spellings pydantic-settings accepted', () => {
		for (const raw of ['0', 'false', 'False', 'no', 'off']) {
			assert.equal(loadSettings({ EMBERLINE__LLAMA_MANAGED: raw }).llamaManaged, false, raw);
		}
		for (const raw of ['1', 'true', 'True', 'yes', 'on']) {
			assert.equal(loadSettings({ EMBERLINE__RING_ENABLED: raw }).ringEnabled, true, raw);
		}
	});

	it('parses list vars as JSON, with a whitespace fallback', () => {
		assert.deepEqual(
			loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '["-ngl", "99"]' }).llamaExtraArgs,
			['-ngl', '99'],
		);
		assert.deepEqual(loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '-ngl 99' }).llamaExtraArgs, [
			'-ngl',
			'99',
		]);
		assert.deepEqual(loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '' }).llamaExtraArgs, []);
	});

	it('refuses a malformed value rather than silently defaulting', () => {
		// Startup must fail loudly: a server that quietly ignores EMBERLINE__PORT
		// binds the wrong port and the extension reports "unreachable" forever.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: 'eight thousand' }), /expected a number/);
		assert.throws(() => loadSettings({ EMBERLINE__RING_ENABLED: 'maybe' }), /expected a boolean/);
	});

	it('does not mutate the defaults', () => {
		loadSettings({ EMBERLINE__PORT: '9999' });
		assert.equal(DEFAULTS.port, 8011);
	});

	it('keeps the example threshold on the Jaccard scale', () => {
		// The port bug this guards: 0.65 was a cosine threshold on bge-small
		// embeddings, and Jaccard over identifier tokens is a different scale.
		// Measured on this repo's source, 0.65 still fires -- but on 21% of queries
		// instead of ~100%, so carrying it across would have quietly turned
		// accepted-example retrieval into a rarity rather than breaking it outright.
		// That is the harder kind of regression to notice.
		assert.ok(DEFAULTS.examplesMinSimilarity < 0.5);
	});
});
