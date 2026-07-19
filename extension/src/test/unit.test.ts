import * as assert from 'assert';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';

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

	test('a zero prefix budget yields no prefix', () => {
		// The server-side twin of this function had exactly this off-by-one: a zero
		// budget sliced from the start of the document instead of yielding nothing.
		assert.strictEqual(extractContext('abcdef', 3, 0, 100).prefix, '');
	});

	test('a zero suffix budget yields no suffix', () => {
		assert.strictEqual(extractContext('abcdef', 3, 100, 0).suffix, '');
	});

	test('a prefix budget equal to the available text keeps all of it', () => {
		assert.strictEqual(extractContext('abcdef', 3, 3, 100).prefix, 'abc');
	});

	test('a prefix budget one short keeps the tail, not the head', () => {
		// Which end is dropped is the whole point: the characters next to the cursor
		// carry the signal, so trimming from the front is correct and trimming from
		// the back would send the model the beginning of the file.
		assert.strictEqual(extractContext('abcdef', 3, 2, 100).prefix, 'bc');
	});

	test('a cursor at offset zero yields the head of the document as suffix', () => {
		const { prefix, suffix } = extractContext('abcdef', 0, 10, 10);
		assert.strictEqual(prefix, '');
		assert.strictEqual(suffix, 'abcdef');
	});

	test('a cursor at the end of the document yields the whole prefix', () => {
		const { prefix, suffix } = extractContext('abcdef', 6, 10, 10);
		assert.strictEqual(prefix, 'abcdef');
		assert.strictEqual(suffix, '');
	});

	test('an offset past the end of the document does not throw', () => {
		// The extension computes the offset from a document that may have changed
		// under it; String.slice clamps rather than throwing, so this degrades to
		// "whole prefix, empty suffix" instead of failing the completion.
		const { prefix, suffix } = extractContext('abc', 10, 100, 100);
		assert.strictEqual(prefix, 'abc');
		assert.strictEqual(suffix, '');
	});

	test('empty text yields empty context', () => {
		const { prefix, suffix } = extractContext('', 0, 10, 10);
		assert.strictEqual(prefix, '');
		assert.strictEqual(suffix, '');
	});

	test('an offset inside a surrogate pair does not throw', () => {
		// VS Code offsets are UTF-16 code units, so a cursor can land between the two
		// halves of an emoji. The split is allowed to produce lone surrogates -- the
		// server hashes context as UTF-16LE for precisely this reason -- but it must
		// not throw and lose the completion.
		const text = 'a\u{1F600}b';
		const { prefix, suffix } = extractContext(text, 2, 10, 10);
		assert.strictEqual(prefix + suffix, text);
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

	test('a rest exactly at the budget is not suppressed', () => {
		// The comparison is `>`, not `>=`: the documented budget is the largest
		// allowed remainder, so the boundary itself must still complete.
		assert.strictEqual(shouldSuppressMidLine('foo(' + 'x'.repeat(8), 4, 8), false);
	});

	test('a rest one over the budget is suppressed', () => {
		assert.strictEqual(shouldSuppressMidLine('foo(' + 'x'.repeat(9), 4, 8), true);
	});

	test('a zero budget suppresses on a single trailing character', () => {
		// Zero means "only complete at end of line"; it must not read as "disabled".
		assert.strictEqual(shouldSuppressMidLine('foo(x', 4, 0), true);
	});

	test('a character position past the line end does not throw', () => {
		// A stale line/character pair from a document that changed mid-request must
		// degrade to "do not suppress" rather than crash the provider.
		assert.strictEqual(shouldSuppressMidLine('foo(', 99, 8), false);
	});

	test('a rest of only whitespace is not suppressed at a zero budget', () => {
		// The trim is what makes indentation and trailing tabs invisible here; without
		// it a zero budget would suppress on every indented blank remainder.
		assert.strictEqual(shouldSuppressMidLine('foo(   \t  ', 4, 0), false);
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

	test('calls that do not overlap each proceed', async () => {
		// The latch is the id, and the id only ever increases -- so a settled call
		// must not leave the debouncer in a state where the next one looks stale.
		// Typing pauses longer than the delay are the common case, not the rare one.
		const d = new Debouncer();
		const signal = new AbortController().signal;
		assert.strictEqual(await d.shouldSkip(10, signal), false);
		assert.strictEqual(await d.shouldSkip(10, signal), false);
	});

	test('keeps instances independent', async () => {
		// The counter is per-instance for the same reason superseding is per-session:
		// a shared latch means two documents cancel each other's completions.
		const a = new Debouncer();
		const b = new Debouncer();
		const signal = new AbortController().signal;
		const results = await Promise.all([a.shouldSkip(30, signal), b.shouldSkip(30, signal)]);
		assert.deepStrictEqual(results, [false, false], 'neither should see the other as newer');
	});
});

suite('client transport', () => {
	const params: CompleteParams = {
		sessionId: 'file:///probe.py',
		prefix: 'def f(',
		suffix: '',
		languageId: 'python',
		path: '/probe.py',
		openPaths: [],
	};

	let server: http.Server;
	let seenPaths: string[] = [];
	let reply: (res: http.ServerResponse) => void = (res) => res.end('{}');
	const base = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	suiteSetup(async () => {
		server = http.createServer((req, res) => {
			seenPaths.push(req.url ?? '');
			req.resume();
			req.on('end', () => reply(res));
		});
		// Ephemeral port: a fixed one collides with whatever else CI is running.
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	});

	suiteTeardown(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	setup(() => {
		seenPaths = [];
		reply = (res) => res.end('{}');
	});

	// Distinct from the unreachable case: the server answered, so this is a real
	// fault and must surface rather than be swallowed as first-run noise.
	test('a non-2xx response fails with the status in the message', async () => {
		reply = (res) => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{}');
		};
		const client = new EmberlineClient(base, () => 5000);
		await assert.rejects(
			() => client.complete(params, new AbortController().signal),
			(err: Error) => {
				assert.ok(!(err instanceof ServerUnreachableError), 'a live server is reachable');
				assert.ok(/500/.test(err.message), `expected the status in ${err.message}`);
				return true;
			},
		);
	});

	test('a response with no completion field yields an empty completion', async () => {
		// The client is deliberately defensive: a shape mismatch must render nothing,
		// not throw out of the provider and flash the status bar red.
		reply = (res) => res.end(JSON.stringify({ cached: false }));
		const client = new EmberlineClient(base, () => 5000);
		const out = await client.complete(params, new AbortController().signal);
		assert.strictEqual(out.completion, '');
	});

	test('a non-string completion yields an empty completion', async () => {
		reply = (res) => res.end(JSON.stringify({ completion: 42 }));
		const client = new EmberlineClient(base, () => 5000);
		const out = await client.complete(params, new AbortController().signal);
		assert.strictEqual(out.completion, '');
	});

	test('a trailing slash on the endpoint is not doubled', async () => {
		// The endpoint comes from user settings, where a trailing slash is a normal
		// thing to type; '//v1/complete' would 404 and read as a broken server.
		const client = new EmberlineClient(() => `${base()}/`, () => 5000);
		await client.complete(params, new AbortController().signal);
		assert.deepStrictEqual(seenPaths, ['/v1/complete']);
	});
});
