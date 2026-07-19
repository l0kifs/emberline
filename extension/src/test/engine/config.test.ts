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
		assert.throws(() => loadSettings({ EMBERLINE__PORT: 'eight thousand' }), /expected a decimal number/);
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

	it('rejects a numeric var that is set but empty', () => {
		// `Number('')` is 0, so `EMBERLINE__PORT=` -- a var exported with no value,
		// which is exactly what an unset shell variable expands to -- used to become a
		// valid-looking zero and bind port 0. Emptiness must fail before coercion.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '' }), /expected a decimal number/);
	});

	it('rejects a numeric var that is only whitespace', () => {
		// `Number('   ')` is also 0, so trimming alone is not enough to escape the
		// zero above.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '   ' }), /expected a decimal number/);
	});

	it('names the offending env var when a number will not parse', () => {
		// The message is the only diagnostic: the server exits non-zero at startup
		// and the extension reports the exit code, not the value that caused it.
		assert.throws(
			() => loadSettings({ EMBERLINE__N_PREDICT: 'abc' }),
			/EMBERLINE__N_PREDICT: expected a decimal number/,
		);
	});

	it('rejects a non-finite number spelled out', () => {
		assert.throws(() => loadSettings({ EMBERLINE__N_PREDICT: 'Infinity' }), /expected a decimal number/);
	});

	it('rejects a number that overflows to infinity', () => {
		// `Number('1e400')` is Infinity, which reads as a plain numeric literal but
		// is not finite -- the same rejection path as 'Infinity'.
		assert.throws(() => loadSettings({ EMBERLINE__N_PREDICT: '1e400' }), /expected a decimal number/);
	});

	it('rejects a number below its range', () => {
		// A negative port or token budget used to pass config on a finiteness check
		// alone and fail much later -- at bind time, or as a llama-server argument.
		// Bounds now reject it at startup, naming the field.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '-1' }), /PORT: must be >= 1/);
		assert.throws(() => loadSettings({ EMBERLINE__N_PREDICT: '-5' }), /N_PREDICT: must be >= 1/);
	});

	it('rejects a number above its range', () => {
		// A port past 65535 cannot be bound; catch it here rather than as an opaque
		// listen error.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '70000' }), /PORT: must be <= 65535/);
		assert.throws(() => loadSettings({ EMBERLINE__TOP_P: '1.5' }), /TOP_P: must be <= 1/);
	});

	it('rejects a chunk-lines value of zero', () => {
		// The bug this guards is the sharpest of the range failures: ringChunkLines
		// feeds `start += chunkLines` in ring.ts, so 0 makes the chunk loop increment
		// by nothing and spin forever, wedging the event loop with no way out.
		assert.throws(
			() => loadSettings({ EMBERLINE__RING_CHUNK_LINES: '0' }),
			/RING_CHUNK_LINES: must be >= 1/,
		);
	});

	it('accepts an explicit zero where the field allows it', () => {
		// Not every field forbids zero: EMBERLINE__IDLE_TIMEOUT_S=0 disables the idle
		// exit and must keep working. This is why the empty-string rejection cannot
		// simply be "falsy is invalid".
		assert.equal(loadSettings({ EMBERLINE__IDLE_TIMEOUT_S: '0' }).idleTimeoutS, 0);
	});

	it('rejects a fractional value for an integer field', () => {
		// A fractional port used to survive config and reach `server.listen`. Integer
		// fields now reject it.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '8011.5' }), /PORT: expected an integer/);
	});

	it('accepts a fractional value for a non-integer field', () => {
		// The integer check is per-field: temperature and the similarity threshold are
		// genuinely fractional and must still parse.
		assert.equal(loadSettings({ EMBERLINE__TEMPERATURE: '0.7' }).temperature, 0.7);
		assert.equal(
			loadSettings({ EMBERLINE__EXAMPLES_MIN_SIMILARITY: '0.25' }).examplesMinSimilarity,
			0.25,
		);
	});

	it('rejects a hex literal for a number', () => {
		// `Number('0x10')` is 16, so a hex-looking value used to be silently base-16.
		// A decimal-only grammar rejects it rather than binding port 16.
		assert.throws(() => loadSettings({ EMBERLINE__PORT: '0x10' }), /PORT: expected a decimal number/);
	});

	it('trims whitespace around a valid number', () => {
		// Shell quoting leaves padding all the time; it must not be a startup failure.
		assert.equal(loadSettings({ EMBERLINE__PORT: ' 8011 ' }).port, 8011);
	});

	it('rejects a boolean var that is set but empty', () => {
		// Asymmetry worth pinning: '' is a *value* for a string field but an error
		// for a boolean, because there is no defensible default to infer from it.
		assert.throws(() => loadSettings({ EMBERLINE__RING_ENABLED: '' }), /expected a boolean/);
	});

	it('names the offending env var when a boolean will not parse', () => {
		assert.throws(
			() => loadSettings({ EMBERLINE__LLAMA_MANAGED: 'maybe' }),
			/EMBERLINE__LLAMA_MANAGED: expected a boolean/,
		);
	});

	it('matches boolean spellings case-insensitively', () => {
		// Env vars are written by hand; TRUE and true must not disagree.
		for (const raw of ['TRUE', 'Yes', 'ON']) {
			assert.equal(loadSettings({ EMBERLINE__RING_ENABLED: raw }).ringEnabled, true, raw);
		}
	});

	it('parses a JSON array of strings for a list var', () => {
		assert.deepEqual(
			loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '["--verbose", "-ngl", "99"]' })
				.llamaExtraArgs,
			['--verbose', '-ngl', '99'],
		);
	});

	it('rejects a list var whose JSON is malformed', () => {
		// The leading '[' commits to the JSON branch, so this cannot quietly fall
		// through to the whitespace split and become the two tokens '[1,2'.
		assert.throws(
			() => loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '[1,2' }),
			/expected a JSON array/,
		);
	});

	it('rejects a list var holding non-strings', () => {
		// These become argv for llama-server; a number would stringify to something
		// plausible and the mistake would only show up in the subprocess.
		assert.throws(
			() => loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '[1,2]' }),
			/expected an array of strings/,
		);
	});

	it('splits a list var on runs of whitespace without emitting empties', () => {
		// An empty argv entry is not an error llama-server reports usefully.
		assert.deepEqual(
			loadSettings({ EMBERLINE__LLAMA_EXTRA_ARGS: '-ngl   99\t\t--verbose' }).llamaExtraArgs,
			['-ngl', '99', '--verbose'],
		);
	});

	it('rejects an empty string for a string var', () => {
		// '' used to be taken literally, so EMBERLINE__LLAMA_BINARY= clobbered the
		// working default with an empty binary path -- the exported-but-unset shell
		// var again, one type over from the empty-number bug.
		assert.throws(() => loadSettings({ EMBERLINE__LLAMA_BINARY: '' }), /LLAMA_BINARY: must not be empty/);
	});

	it('allows an empty string only for the preset', () => {
		// llamaPreset is the one string field where empty is a real choice: it can be
		// blanked to drive the model entirely through EMBERLINE__LLAMA_EXTRA_ARGS.
		assert.equal(loadSettings({ EMBERLINE__LLAMA_PRESET: '' }).llamaPreset, '');
	});

	it('ignores env vars outside the EMBERLINE__ prefix', () => {
		// A bare PORT is set in most CI and container environments; picking it up
		// would move the server out from under the extension's configured endpoint.
		assert.equal(loadSettings({ PORT: '9999' }).port, DEFAULTS.port);
	});

	it('keeps the underscore before a trailing single-letter suffix', () => {
		// The camel-to-snake regex splits on a lower/digit followed by an upper, so
		// the lone trailing 'S' of llamaStartupTimeoutS becomes its own segment --
		// EMBERLINE__LLAMA_STARTUP_TIMEOUT_S, not ..._TIMEOUTS.
		assert.equal(
			loadSettings({ EMBERLINE__LLAMA_STARTUP_TIMEOUT_S: '42' }).llamaStartupTimeoutS,
			42,
		);
	});

	it('keeps the underscore before a single-letter suffix after a digit boundary', () => {
		// `topK` -> EMBERLINE__TOP_K only because the regex accepts a digit or a
		// lowercase letter on the left; a `[a-z]`-only class would give TOPK.
		assert.equal(loadSettings({ EMBERLINE__TOP_K: '7' }).topK, 7);
	});
});
