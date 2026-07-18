/**
 * New in the TS port: infill.py was in the untested I/O half, and its port has
 * the sharpest edge in the migration -- see LineDecoder's docstring.
 */

import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { after, describe, it } from 'node:test';

import { InfillClient, InfillError, LineDecoder } from '../../engine/infill';
import type { InfillRequest } from '../../engine/types';

const REQ: InfillRequest = {
	prefix: 'def add(a, b):\n    ',
	suffix: '\n',
	extra: [],
	n_predict: 128,
	t_max_predict_ms: 1000,
	temperature: 0.1,
	top_p: 0.9,
	top_k: 40,
};

function sseFrames(...frames: object[]): string {
	return frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('');
}

const CLOSERS: Array<() => void> = [];
after(() => CLOSERS.forEach((c) => c()));

/** A stand-in llama-server. `handler` writes the response body itself. */
async function fakeLlama(
	handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<string> {
	const server = http.createServer(handler);
	await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
	CLOSERS.push(() => server.close());
	const addr = server.address();
	if (addr === null || typeof addr === 'string') {
		throw new Error('no port');
	}
	return `http://127.0.0.1:${addr.port}`;
}

describe('line decoder', () => {
	const BODY = sseFrames(
		{ content: 'return ' },
		{ content: 'a + b' },
		{ content: '', stop: true, stop_type: 'eos', timings: { predicted_n: 3 } },
	);

	it('reassembles lines split at any byte offset', () => {
		// The bug this guards: a transport chunk is not a message. Splitting each
		// chunk on '\n' independently tears JSON frames in half, which shows up as
		// dropped tokens under load and reads as the model misbehaving.
		const bytes = Buffer.from(BODY, 'utf8');
		const whole = new LineDecoder();
		const expected = [...whole.push(bytes), ...whole.flush()];

		for (let cut = 1; cut < bytes.length; cut++) {
			const d = new LineDecoder();
			const got = [
				...d.push(bytes.subarray(0, cut)),
				...d.push(bytes.subarray(cut)),
				...d.flush(),
			];
			assert.deepEqual(got, expected, `split at byte ${cut}`);
		}
	});

	it('reassembles a stream delivered one byte at a time', () => {
		const bytes = Buffer.from(BODY, 'utf8');
		const d = new LineDecoder();
		const got: string[] = [];
		for (const b of bytes) {
			got.push(...d.push(Buffer.from([b])));
		}
		got.push(...d.flush());
		const whole = new LineDecoder();
		assert.deepEqual(got, [...whole.push(bytes), ...whole.flush()]);
	});

	it('reassembles a multi-byte character split across chunks', () => {
		// The same hazard one level down: UTF-8 continuation bytes straddling a
		// chunk boundary. A per-chunk toString() yields two replacement characters
		// where the model emitted one character.
		const bytes = Buffer.from('data: {"content":"→"}\n', 'utf8');
		const cut = bytes.indexOf(0xe2) + 1; // mid-way through the arrow
		const d = new LineDecoder();
		const got = [...d.push(bytes.subarray(0, cut)), ...d.push(bytes.subarray(cut))];
		assert.deepEqual(got, ['data: {"content":"→"}']);
	});

	it('strips CR from CRLF terminators', () => {
		const d = new LineDecoder();
		assert.deepEqual(d.push(Buffer.from('data: x\r\ndata: y\r\n')), ['data: x', 'data: y']);
	});

	it('yields nothing for a chunk with no newline', () => {
		const d = new LineDecoder();
		assert.deepEqual(d.push(Buffer.from('data: par')), []);
		assert.deepEqual(d.push(Buffer.from('tial\n')), ['data: partial']);
	});
});

describe('infill client', () => {
	it('concatenates streamed content and reports stop metadata', async () => {
		const base = await fakeLlama((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(
				sseFrames(
					{ content: 'return ' },
					{ content: 'a + b' },
					{ content: '', stop: true, stop_type: 'eos', timings: { predicted_n: 3 } },
				),
			);
		});
		const client = new InfillClient(base);
		const out = await client.infill(REQ);
		client.close();

		assert.equal(out.content, 'return a + b');
		assert.equal(out.stopType, 'eos');
		assert.equal(out.superseded, false);
		assert.deepEqual(out.timings, { predicted_n: 3 });
	});

	it('sends the payload llama.cpp /infill expects', async () => {
		let seen: Record<string, unknown> = {};
		const base = await fakeLlama((req, res) => {
			const chunks: Buffer[] = [];
			req.on('data', (c: Buffer) => chunks.push(c));
			req.on('end', () => {
				seen = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				res.writeHead(200, { 'content-type': 'text/event-stream' });
				res.end(sseFrames({ content: 'x', stop: true, stop_type: 'eos' }));
			});
		});
		const client = new InfillClient(base);
		await client.infill(REQ);
		client.close();

		assert.equal(seen.input_prefix, REQ.prefix);
		assert.equal(seen.input_suffix, REQ.suffix);
		assert.deepEqual(seen.input_extra, []);
		assert.equal(seen.stream, true);
		// cache_prompt and n_cache_reuse are what make a warm KV cache pay off.
		assert.equal(seen.cache_prompt, true);
		assert.equal(seen.n_cache_reuse, 256);
		assert.equal(seen.timings_per_token, true);
	});

	it('abandons the generation when superseded', async () => {
		// The point of streaming a non-streaming API: a newer keystroke must be able
		// to stop llama-server mid-generation instead of paying for the full budget.
		const base = await fakeLlama((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			let n = 0;
			const timer = setInterval(() => {
				if (res.writableEnded || res.destroyed) {
					clearInterval(timer);
					return;
				}
				res.write(sseFrames({ content: `tok${n++}` }));
			}, 5);
			res.on('close', () => clearInterval(timer));
		});
		const client = new InfillClient(base);
		let frames = 0;
		const out = await client.infill(REQ, { shouldStop: () => ++frames > 2 });
		client.close();

		assert.equal(out.superseded, true);
		// Whatever arrived before the stop is kept; the caller decides to drop it.
		assert.equal(out.stopType, null);
		assert.ok(out.content.startsWith('tok0'), out.content);
	});

	it('throws with the body on a non-200', async () => {
		const base = await fakeLlama((_req, res) => {
			res.writeHead(500, { 'content-type': 'application/json' });
			res.end('{"error":{"message":"no slot available"}}');
		});
		const client = new InfillClient(base);
		await assert.rejects(client.infill(REQ), (err: Error) => {
			assert.ok(err instanceof InfillError);
			assert.match(err.message, /500/);
			assert.match(err.message, /no slot available/);
			return true;
		});
		client.close();
	});

	it('skips undecodable frames instead of failing the completion', async () => {
		const base = await fakeLlama((_req, res) => {
			res.writeHead(200, { 'content-type': 'text/event-stream' });
			res.end(
				'data: {"content":"ok"}\n\n' +
					'data: {not json\n\n' +
					sseFrames({ content: '!', stop: true, stop_type: 'eos' }),
			);
		});
		const client = new InfillClient(base);
		const logged: string[] = [];
		const out = await client.infill(REQ, { log: (m) => logged.push(m) });
		client.close();

		assert.equal(out.content, 'ok!');
		assert.equal(logged.length, 1);
	});

	it('times out when nothing answers, without a read timeout', async () => {
		// Connect and headers are bounded; generation is not. A read timeout here
		// would cut off exactly the slow completions n_predict is meant to govern.
		const base = await fakeLlama(() => {
			/* accept the request and never respond */
		});
		const client = new InfillClient(base, 150);
		await assert.rejects(client.infill(REQ), /no response within 150ms/);
		client.close();
	});
});
