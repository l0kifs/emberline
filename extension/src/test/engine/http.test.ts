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
});
