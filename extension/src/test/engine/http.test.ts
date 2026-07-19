/**
 * The HTTP surface, driven the way the extension drives it.
 *
 * This is the phase-3 milestone from docs/typescript-migration.md: the wire is
 * frozen, so these requests are byte-identical to what client/http.ts sends and
 * what the Python server answered.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { Assembler } from '../../engine/assemble';
import { CompletionCache } from '../../engine/cache';
import { DEFAULTS, type Settings } from '../../engine/config';
import { ExampleStore } from '../../engine/examples';
import { createServer, type EngineContext } from '../../engine/http';
import { IdleShutdown } from '../../engine/idle';
import { InfillClient } from '../../engine/infill';
import { Supersede } from '../../engine/supersede';

const CLOSERS: Array<() => void> = [];
after(() => CLOSERS.forEach((c) => c()));

async function listen(server: http.Server): Promise<string> {
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	CLOSERS.push(() => {
		server.close();
		server.closeAllConnections();
	});
	const addr = server.address();
	if (addr === null || typeof addr === 'string') {
		throw new Error('no port');
	}
	return `http://127.0.0.1:${addr.port}`;
}

interface Fake {
	base: string;
	/** Responses whose stream was torn down rather than completed. */
	destroyed: number;
	requests: number;
	/** Every /infill payload received, so tests can assert on assembled context. */
	payloads: Record<string, any>[];
}

/**
 * A llama-server stand-in that streams `tokens` with a delay between each, so a
 * generation is long enough to supersede or disconnect mid-flight.
 */
async function fakeLlama(tokens: string[], delayMs = 0): Promise<Fake> {
	const fake: Fake = { base: '', destroyed: 0, requests: 0, payloads: [] };
	const server = http.createServer((req, res) => {
		if (req.url === '/health') {
			res.writeHead(200).end('{}');
			return;
		}
		fake.requests++;
		const body: Buffer[] = [];
		req.on('data', (c: Buffer) => body.push(c));
		req.on('end', () => {
			try {
				fake.payloads.push(JSON.parse(Buffer.concat(body).toString('utf8')));
			} catch {
				/* not our concern here */
			}
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			let i = 0;
			let finished = false;
			res.on('close', () => {
				if (!finished) {
					fake.destroyed++;
				}
			});
			const tick = () => {
				if (res.writableEnded || res.destroyed) {
					return;
				}
				if (i < tokens.length) {
					res.write(`data: ${JSON.stringify({ content: tokens[i++] })}\n\n`);
					setTimeout(tick, delayMs);
					return;
				}
				finished = true;
				res.end(
					`data: ${JSON.stringify({
						content: '',
						stop: true,
						stop_type: 'eos',
						timings: { predicted_n: tokens.length, cache_n: 1 },
					})}\n\n`,
				);
			};
			tick();
		});
	});
	fake.base = await listen(server);
	return fake;
}

function context(fake: Fake, over: Partial<Settings> = {}): EngineContext {
	const url = new URL(fake.base);
	const settings: Settings = {
		...DEFAULTS,
		llamaHost: url.hostname,
		llamaPort: Number(url.port),
		...over,
	};
	return {
		settings,
		infill: new InfillClient(fake.base),
		cache: new CompletionCache(settings.cacheMaxEntries),
		supersede: new Supersede(),
		assembler: new Assembler(settings, { ring: null, examples: null }),
		examples: null,
		paramsDigest: 'testdigest',
		idle: new IdleShutdown(0),
		log: () => {},
	};
}

async function engine(tokens: string[], delayMs = 0, over: Partial<Settings> = {}) {
	const fake = await fakeLlama(tokens, delayMs);
	const ctx = context(fake, over);
	const base = await listen(createServer(ctx));
	CLOSERS.push(() => ctx.infill.close());
	return { base, ctx, fake };
}

/** `Response.json()` is `unknown`; these are our own responses, so unwrap once. */
async function jsonOf(res: Response | Promise<Response>): Promise<Record<string, any>> {
	return (await (await res).json()) as Record<string, any>;
}

function complete(base: string, body: Record<string, unknown>, signal?: AbortSignal) {
	return fetch(`${base}/v1/complete`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			session_id: 'file:///a.py',
			prefix: 'def add(a, b):\n    ',
			suffix: '\n',
			language_id: 'python',
			path: '/a.py',
			open_paths: [],
			...body,
		}),
		signal,
	});
}

function accept(base: string, body: Record<string, unknown>) {
	return fetch(`${base}/v1/accept`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ prefix: 'p', completion: 'c', language_id: 'python', ...body }),
	});
}

/** An engine backed by a real ExampleStore in a throwaway directory. */
async function engineWithExamples() {
	const fake = await fakeLlama(['x']);
	const ctx = context(fake);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-http-ex-'));
	CLOSERS.push(() => fs.rmSync(dir, { recursive: true, force: true }));

	const examples = new ExampleStore({
		filePath: path.join(dir, 'examples.jsonl'),
		topK: 3,
		minSimilarity: 0.15,
		maxRows: 100,
	});
	await examples.start();
	ctx.examples = examples;
	ctx.assembler = new Assembler(ctx.settings, { ring: null, examples });
	const base = await listen(createServer(ctx));
	CLOSERS.push(() => ctx.infill.close());
	return { base, ctx, examples, fake };
}

/**
 * Makes every later request stale the instant it claims its generation, by
 * claiming a second time on its behalf. Deterministic where racing two real
 * requests is not.
 */
function staleOnArrival(ctx: EngineContext): void {
	const real = ctx.supersede.claim.bind(ctx.supersede);
	ctx.supersede.claim = (sessionId: string) => {
		const generation = real(sessionId);
		real(sessionId);
		return generation;
	};
}

/**
 * An engine whose llama-server answers the first /infill with a non-200 and
 * every later one normally, so the error path and the recovery after it can be
 * driven through the real transport.
 */
async function engineWithFailingLlama(tokens: string[]) {
	const good = await fakeLlama(tokens);
	let failed = false;
	const proxy = http.createServer((req, res) => {
		if (req.url === '/infill' && !failed) {
			failed = true;
			req.resume();
			res.writeHead(503, { 'content-type': 'text/plain' }).end('no slot available');
			return;
		}
		const upstream = http.request(
			`${good.base}${req.url ?? '/'}`,
			{ method: req.method, headers: { 'content-type': 'application/json' } },
			(up) => {
				res.writeHead(up.statusCode ?? 502, {
					'content-type': up.headers['content-type'] ?? 'text/plain',
				});
				up.pipe(res);
			},
		);
		upstream.on('error', () => res.writeHead(502).end());
		req.pipe(upstream);
	});
	const llamaBase = await listen(proxy);
	const ctx = context({ ...good, base: llamaBase });
	const base = await listen(createServer(ctx));
	CLOSERS.push(() => ctx.infill.close());
	return { base, ctx, good };
}

describe('POST /v1/complete', () => {
	it('returns the generated completion', async () => {
		const { base } = await engine(['return ', 'a + b']);
		const res = await complete(base, {});
		const json = await jsonOf(res);

		assert.equal(res.status, 200);
		assert.deepEqual(json, {
			completion: 'return a + b',
			cached: false,
			superseded: false,
			stop_type: 'eos',
			// Only the four fields the extension reports; cache_n is dropped.
			timings: { predicted_n: 2 },
		});
	});

	it('serves a repeat of the same context from cache', async () => {
		const { base, fake } = await engine(['return ', 'a + b']);
		await complete(base, {});
		const json = await jsonOf(complete(base, {}));

		assert.equal(json.cached, true);
		assert.equal(json.completion, 'return a + b');
		// A cache hit ignores staleness and never reaches the model.
		assert.equal(fake.requests, 1);
	});

	it('reports the older request superseded when a newer one lands', async () => {
		// The core of the design: one model, one lock, newest wins.
		const { base } = await engine(['tok'.repeat(1), 'a', 'b', 'c', 'd'], 25);
		const first = complete(base, { prefix: 'first prefix here' });
		await new Promise((r) => setTimeout(r, 40));
		const second = complete(base, { prefix: 'second prefix here' });

		const [a, b] = await Promise.all([jsonOf(first), jsonOf(second)]);
		assert.equal(a.superseded, true);
		assert.equal(a.completion, '');
		assert.equal(b.superseded, false);
	});

	it('keeps sessions independent', async () => {
		// The bug this guards: a global counter means two editors abort each other.
		const { base } = await engine(['x'], 5);
		const [a, b] = await Promise.all([
			jsonOf(complete(base, { session_id: 'file:///a.py', prefix: 'aaa aaa' })),
			jsonOf(complete(base, { session_id: 'file:///b.py', prefix: 'bbb bbb' })),
		]);
		assert.equal(a.superseded, false);
		assert.equal(b.superseded, false);
	});

	it('abandons the generation when the client disconnects', async () => {
		// Without this an abandoned keystroke holds the global model lock for a full
		// generation, and every later request queues behind a suggestion nobody will
		// ever see.
		const { base, ctx, fake } = await engine(['a', 'b', 'c', 'd', 'e', 'f'], 30);
		const ac = new AbortController();
		const inflight = complete(base, {}, ac.signal);
		await new Promise((r) => setTimeout(r, 60));
		ac.abort();
		await assert.rejects(inflight);

		// The generation must actually stop, not merely be ignored: the lock is
		// released only when /infill is done, so a live stream here would block the
		// next keystroke.
		await new Promise((r) => setTimeout(r, 60));
		assert.equal(fake.destroyed, 1);

		// And the lock is free: the next request completes normally.
		const next = await jsonOf(complete(base, { prefix: 'later prefix' }));
		assert.equal(next.superseded, false);
		assert.ok(!ctx.supersede.isStale('file:///a.py', 2));
	});

	it('rejects a malformed body with 422, not 500', async () => {
		const { base } = await engine(['x']);
		const missing = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prefix: 'x' }),
		});
		assert.equal(missing.status, 422);
		assert.match((await jsonOf(missing)).detail, /session_id/);

		const garbage = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json',
		});
		assert.equal(garbage.status, 422);
	});

	it('answers an oversized body with a 422 envelope, not a dropped connection', async () => {
		// The bug this guards: overflow used to `req.destroy()`, which took the socket
		// down with the response, so the client saw ECONNRESET rather than the 422.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				session_id: 'file:///a.py',
				prefix: 'x'.repeat(9 * 1024 * 1024),
				suffix: '',
				language_id: 'python',
				path: '/a.py',
				open_paths: [],
			}),
		});
		assert.equal(res.status, 422);
		assert.match((await jsonOf(res)).detail, /too large/);
	});

	it('processes a body just under the size limit', async () => {
		// The other half of the boundary: the cap must reject only what exceeds it.
		const { base } = await engine(['return ', 'a + b']);
		const body = JSON.stringify({
			session_id: 'file:///a.py',
			prefix: 'x'.repeat(8 * 1024 * 1024 - 4096),
			suffix: '',
			language_id: 'python',
			path: '/a.py',
			open_paths: [],
		});
		assert.ok(Buffer.byteLength(body) < 8 * 1024 * 1024);

		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
		});
		assert.equal(res.status, 200);
		assert.equal((await jsonOf(res)).completion, 'return a + b');
	});

	it('rejects an empty body with 422', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '',
		});
		assert.equal(res.status, 422);
		assert.ok(typeof (await jsonOf(res)).detail === 'string');
	});

	it('rejects a JSON array body with 422', async () => {
		// Valid JSON, wrong shape: `typeof [] === 'object'`, so an array slips past a
		// naive object check and every field reads as undefined.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '[]',
		});
		assert.equal(res.status, 422);
		assert.match((await jsonOf(res)).detail, /JSON object/);
	});

	it('rejects a JSON string body with 422', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '"str"',
		});
		assert.equal(res.status, 422);
		assert.match((await jsonOf(res)).detail, /JSON object/);
	});

	it('answers a validation failure with a JSON error envelope', async () => {
		// Machine-readable on every non-2xx path: the extension parses `detail`, and
		// a framework's HTML error page would be a TypeError at the client.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prefix: 'x' }),
		});
		assert.equal(res.status, 422);
		assert.equal(res.headers.get('content-type'), 'application/json');
		assert.equal(typeof (await jsonOf(res)).detail, 'string');
	});

	it('returns cleanly when the model streams no content', async () => {
		const { base, fake } = await engine([]);
		const json = await jsonOf(complete(base, {}));
		assert.equal(json.completion, '');
		assert.equal(json.superseded, false);

		// An empty completion is never cached -- caching it would pin a document at
		// "no suggestion" for as long as the entry lived.
		const again = await jsonOf(complete(base, {}));
		assert.equal(again.cached, false);
		assert.equal(fake.requests, 2);
	});

	it('serves a cache hit even when the request is already stale', async () => {
		// Documented behaviour: the answer is already correct for this context and
		// costs nothing, so a hit ignores staleness and reports superseded: false.
		const { base, ctx, fake } = await engine(['return ', 'a + b']);
		assert.equal((await jsonOf(complete(base, {}))).cached, false);

		staleOnArrival(ctx);
		const json = await jsonOf(complete(base, {}));
		assert.equal(json.cached, true);
		assert.equal(json.superseded, false);
		assert.equal(json.completion, 'return a + b');
		assert.equal(fake.requests, 1);
	});

	it('reports superseded without reaching the model when stale before the lock', async () => {
		const { base, ctx, fake } = await engine(['return ', 'a + b']);
		staleOnArrival(ctx);
		const json = await jsonOf(complete(base, { prefix: 'uncached prefix here' }));
		assert.equal(json.superseded, true);
		assert.equal(json.completion, '');
		assert.equal(fake.requests, 0);
	});

	it('runs two concurrent sessions to completion', async () => {
		// The global model lock serializes them -- it must not drop either.
		const { base, fake } = await engine(['return ', 'a + b']);
		const [a, b] = await Promise.all([
			jsonOf(complete(base, { session_id: 'file:///a.py', prefix: 'aaa aaa' })),
			jsonOf(complete(base, { session_id: 'file:///b.py', prefix: 'bbb bbb' })),
		]);
		assert.equal(a.completion, 'return a + b');
		assert.equal(b.completion, 'return a + b');
		assert.equal(fake.requests, 2);
	});

	it('surfaces a 500 envelope when llama-server answers a non-200', async () => {
		const { base } = await engineWithFailingLlama(['return ', 'a + b']);
		const res = await complete(base, {});
		assert.equal(res.status, 500);
		assert.equal(res.headers.get('content-type'), 'application/json');
		assert.equal((await jsonOf(res)).detail, 'internal error');
	});

	it('releases the model lock when llama-server errors', async () => {
		// The valuable half: an error thrown inside runExclusive must still release,
		// or the first bad generation wedges every later keystroke forever.
		const { base } = await engineWithFailingLlama(['return ', 'a + b']);
		assert.equal((await complete(base, {})).status, 500);

		const json = await jsonOf(
			complete(base, { prefix: 'later prefix' }, AbortSignal.timeout(5000)),
		);
		assert.equal(json.completion, 'return a + b');
		assert.equal(json.superseded, false);
	});
});

describe('POST /v1/accept', () => {
	it('accepts and reports the store size', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/accept`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ prefix: 'p', completion: 'c', language_id: 'python' }),
		});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { examples: 0 });
	});

	it('feeds an accepted completion back into the next request as context', async () => {
		// The whole point of the accept endpoint: accepted completions become
		// few-shot examples in input_extra, which llama.cpp inserts ahead of the
		// FIM prefix. This closes the loop through the real route surface.
		const fake = await fakeLlama(['x']);
		const ctx = context(fake);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-http-ex-'));
		CLOSERS.push(() => fs.rmSync(dir, { recursive: true, force: true }));

		const examples = new ExampleStore({
			filePath: path.join(dir, 'examples.jsonl'),
			topK: 3,
			minSimilarity: 0.15,
			maxRows: 100,
		});
		await examples.start();
		ctx.examples = examples;
		ctx.assembler = new Assembler(ctx.settings, { ring: null, examples });
		const base = await listen(createServer(ctx));
		CLOSERS.push(() => ctx.infill.close());

		const accepted = await jsonOf(
			fetch(`${base}/v1/accept`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					prefix: 'def compute_total(order_items):\n    ',
					completion: 'return sum(i.price for i in order_items)',
					language_id: 'python',
				}),
			}),
		);
		assert.deepEqual(accepted, { examples: 1 });

		await complete(base, { prefix: 'def compute_total(order_items):\n    ' });
		const extra = fake.payloads.at(-1)?.input_extra ?? [];
		assert.equal(extra.length, 1, JSON.stringify(extra));
		assert.equal(extra[0].filename, 'accepted_example');
		assert.match(extra[0].text, /sum\(i\.price/);
	});

	it('answers 200 with zero examples when retrieval is disabled', async () => {
		// `ctx.examples === null` is a supported configuration, not an error: the
		// route must short-circuit rather than dereference it.
		const { base, ctx } = await engine(['x']);
		assert.equal(ctx.examples, null);
		const res = await accept(base, {});
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { examples: 0 });
	});

	it('drops a whitespace-only completion', async () => {
		// ExampleStore.add discards it; the route must still answer 200 with the
		// unchanged count rather than reporting a store that did not grow.
		const { base, examples } = await engineWithExamples();
		const res = await accept(base, { prefix: 'def f():\n    ', completion: '   \n\t ' });
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), { examples: 0 });
		assert.equal(examples.count(), 0);
	});

	it('does not deduplicate identical accepts', async () => {
		// Verified behaviour: the store appends unconditionally, so the same accept
		// twice is two rows. Worth pinning -- it is a choice, not an accident.
		const { base, examples } = await engineWithExamples();
		const body = { prefix: 'def f():\n    ', completion: 'return 1' };
		assert.deepEqual(await (await accept(base, body)).json(), { examples: 1 });
		assert.deepEqual(await (await accept(base, body)).json(), { examples: 2 });
		assert.equal(examples.count(), 2);
	});
});

describe('GET /health', () => {
	it('reports ok with cache statistics', async () => {
		const { base } = await engine(['return ', 'a + b']);
		await complete(base, {});
		await complete(base, {});
		const json = await jsonOf(fetch(`${base}/health`));

		assert.equal(json.status, 'ok');
		assert.equal(json.llama, 'ok');
		assert.equal(json.cache_entries, 1);
		assert.equal(json.cache_hits, 1);
		assert.equal(json.cache_misses, 1);
	});

	it('reports degraded when llama is unreachable', async () => {
		const { base } = await engine(['x'], 0, { llamaPort: 1 });
		const json = await jsonOf(fetch(`${base}/health`));
		assert.equal(json.status, 'degraded');
		assert.equal(json.llama, 'unreachable');
	});

	it('does not count as activity for the idle timer', async () => {
		// A liveness probe means someone is watching, not that anyone is typing.
		// Counting probes would defeat the timeout for exactly the abandoned-editor
		// case it exists for.
		const fake = await fakeLlama(['x']);
		const ctx = context(fake);
		let touched = 0;
		ctx.idle = new IdleShutdown(60, { onExpire: () => {} });
		const realTouch = ctx.idle.touch.bind(ctx.idle);
		ctx.idle.touch = () => {
			touched++;
			realTouch();
		};
		const base = await listen(createServer(ctx));
		CLOSERS.push(() => ctx.infill.close());

		await fetch(`${base}/health`);
		assert.equal(touched, 0);
		await complete(base, {});
		assert.equal(touched, 1);
	});
});

describe('routing', () => {
	it('404s an unknown path', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/nope`);
		assert.equal(res.status, 404);
	});

	it('404s an unknown path with a query string', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/nope?x=1`);
		assert.equal(res.status, 404);
	});

	it('routes a known path carrying a query string', async () => {
		// The route is matched on the bare path, so a query string no longer makes a
		// legitimate route unreachable. `req.url` used to be compared literally, which
		// sent `/health?x=1` to the 404 -- a trap for any prober that cache-busts.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/health?x=1`);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { status: string };
		assert.equal(body.status, 'ok');
	});

	it('routes a known path with a trailing slash', async () => {
		// Trailing slashes are stripped for the same reason: `/health/` must reach the
		// same handler as `/health`, not fall through to the 404.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/health/`);
		assert.equal(res.status, 200);
	});

	it('404s a GET of the complete route', async () => {
		// A method mismatch is a routing miss, not a 200 and not a 500.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/complete`);
		assert.equal(res.status, 404);
	});

	it('404s a GET of the accept route', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/accept`);
		assert.equal(res.status, 404);
	});

	it('404s a POST of the health route', async () => {
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/health`, { method: 'POST' });
		assert.equal(res.status, 404);
	});

	it('404s with a JSON error envelope', async () => {
		// Never an HTML error page: the client parses `detail` on every non-2xx.
		const { base } = await engine(['x']);
		const res = await fetch(`${base}/v1/nope`);
		assert.equal(res.headers.get('content-type'), 'application/json');
		assert.equal((await jsonOf(res)).detail, 'not found');
	});
});
