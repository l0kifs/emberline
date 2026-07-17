import * as assert from 'assert';

import {
	AbortedError,
	CompleteParams,
	EmberlineClient,
	ServerUnreachableError,
} from '../client/http';
import { extractContext, shouldSuppressMidLine } from '../completion/context';
import { Debouncer } from '../completion/debounce';

suite('context extraction', () => {
	test('splits at the cursor', () => {
		const { prefix, suffix } = extractContext('abcdef', 3, 100, 100);
		assert.strictEqual(prefix, 'abc');
		assert.strictEqual(suffix, 'def');
	});

	test('keeps the prefix tail and the suffix head', () => {
		const text = 'a'.repeat(100) + 'b'.repeat(100);
		const { prefix, suffix } = extractContext(text, 100, 10, 5);
		assert.strictEqual(prefix, 'a'.repeat(10), 'prefix should keep the tail');
		assert.strictEqual(suffix, 'b'.repeat(5), 'suffix should keep the head');
	});

	test('handles cursor at both ends', () => {
		assert.strictEqual(extractContext('abc', 0, 10, 10).prefix, '');
		assert.strictEqual(extractContext('abc', 3, 10, 10).suffix, '');
	});
});

suite('mid-line suppression', () => {
	test('suppresses when substantial code follows the cursor', () => {
		assert.strictEqual(shouldSuppressMidLine('foo(bar, baz, qux)', 4, 8), true);
	});

	test('allows at end of line', () => {
		assert.strictEqual(shouldSuppressMidLine('foo(', 4, 8), false);
	});

	test('ignores trailing whitespace', () => {
		assert.strictEqual(shouldSuppressMidLine('foo(       ', 4, 8), false);
	});

	test('allows a short closer such as a bare paren', () => {
		assert.strictEqual(shouldSuppressMidLine('foo()', 4, 8), false);
	});
});

suite('client error mapping', () => {
	const params: CompleteParams = {
		sessionId: 'file:///probe.py',
		prefix: 'def f(',
		suffix: '',
		languageId: 'python',
		path: '/probe.py',
		openPaths: [],
	};
	// Port 1 is privileged and never listening, so this refuses rather than hangs.
	const dead = () => 'http://127.0.0.1:1';

	// Emberline bundles no server, so "nothing is listening" is the expected
	// first-run state and the one error that earns a setup prompt. Collapsing it
	// into a generic Error meant a new user saw only "fetch failed".
	test('an unreachable endpoint is reported as ServerUnreachableError', async () => {
		const client = new EmberlineClient(dead, () => 5000);
		await assert.rejects(
			() => client.complete(params, new AbortController().signal),
			(err: Error) => {
				assert.ok(
					err instanceof ServerUnreachableError,
					`expected ServerUnreachableError, got ${err.name}: ${err.message}`,
				);
				assert.strictEqual((err as ServerUnreachableError).endpoint, dead());
				return true;
			},
		);
	});

	// Ordering guard: an abort also surfaces as a fetch rejection, and if the
	// TypeError branch were checked first, every keystroke would look like a dead
	// server and nag the user with the setup prompt.
	test('a cancelled request is an abort, not an unreachable server', async () => {
		const client = new EmberlineClient(dead, () => 5000);
		const ac = new AbortController();
		ac.abort();
		await assert.rejects(
			() => client.complete(params, ac.signal),
			(err: Error) => err instanceof AbortedError,
		);
	});
});

suite('debouncer', () => {
	test('newest call wins, older ones skip', async () => {
		const d = new Debouncer();
		const ac = new AbortController();
		const results = await Promise.all([
			d.shouldSkip(30, ac.signal),
			d.shouldSkip(30, ac.signal),
			d.shouldSkip(30, ac.signal),
		]);
		assert.deepStrictEqual(results, [true, true, false], 'only the last should proceed');
	});

	test('an aborted call skips', async () => {
		const d = new Debouncer();
		const ac = new AbortController();
		const p = d.shouldSkip(50, ac.signal);
		ac.abort();
		assert.strictEqual(await p, true);
	});

	test('zero delay does not skip', async () => {
		const d = new Debouncer();
		assert.strictEqual(await d.shouldSkip(0, new AbortController().signal), false);
	});
});
