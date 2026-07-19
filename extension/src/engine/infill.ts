/**
 * HTTP client for llama.cpp's `POST /infill`.
 *
 * We stream even though our own API does not, for two reasons: we can abandon a
 * generation the moment it is superseded, and we can stop early on our own
 * criteria without waiting for the full n_predict budget.
 *
 * Transport is `node:http` on a keep-alive agent -- see httpc.ts for why this is
 * not the global `fetch`.
 */

import * as http from 'node:http';

import { readAll } from './httpc';
import type { InfillRequest, InfillResult } from './types';

export class InfillError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InfillError';
	}
}

/**
 * Byte chunks in, complete lines out.
 *
 * This exists because it is the single most dangerous line of the Python port.
 * `httpx.aiter_lines()` reassembled lines across chunk boundaries for free; a
 * transport chunk is not a message, so the naive `chunk.toString().split('\n')`
 * splits JSON frames in half and drops tokens. It fails intermittently, under
 * load, in a way that looks like the model misbehaving.
 *
 * `TextDecoder` in streaming mode handles the same hazard one level down, where a
 * multi-byte UTF-8 character straddles a chunk boundary.
 */
export class LineDecoder {
	// Non-fatal on purpose: this decodes model output, and a malformed byte
	// should cost one character, not the whole completion.
	private readonly decoder = new TextDecoder('utf-8');
	private buf = '';

	push(chunk: Uint8Array): string[] {
		this.buf += this.decoder.decode(chunk, { stream: true });
		if (!this.buf.includes('\n')) {
			return [];
		}
		const parts = this.buf.split('\n');
		this.buf = parts.pop() ?? '';
		return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
	}

	/** Any trailing partial line, for a stream that ended without a newline. */
	flush(): string[] {
		this.buf += this.decoder.decode();
		const rest = this.buf;
		this.buf = '';
		if (!rest) {
			return [];
		}
		return [rest.endsWith('\r') ? rest.slice(0, -1) : rest];
	}
}

export class InfillClient {
	private readonly agent: http.Agent;

	constructor(
		private readonly baseUrl: string,
		private readonly connectTimeoutMs = 2000,
	) {
		// No `timeout` option: on an Agent it applies to active sockets too, which
		// would become the read timeout we deliberately do not have. Free sockets
		// stay warm between keystrokes; llama-server decides when to close them.
		this.agent = new http.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });
	}

	close(): void {
		this.agent.destroy();
	}

	/**
	 * Run one FIM completion.
	 *
	 * `shouldStop` is polled per streamed frame; returning true abandons the
	 * generation and reports `superseded: true` with whatever arrived so far.
	 */
	async infill(
		req: InfillRequest,
		opts: {
			shouldStop?: () => boolean;
			/**
			 * Aborts the generation outright, rather than at the next frame like
			 * `shouldStop`. Used for client disconnect: the caller holds the global
			 * model lock, so it must not return until llama-server has actually
			 * stopped -- otherwise the next request generates against a slot that is
			 * still busy.
			 */
			signal?: AbortSignal;
			log?: (message: string) => void;
		} = {},
	): Promise<InfillResult> {
		if (opts.signal?.aborted) {
			return { content: '', stopType: null, superseded: true, timings: {} };
		}
		const payload = JSON.stringify({
			input_prefix: req.prefix,
			input_suffix: req.suffix,
			input_extra: req.extra,
			n_predict: req.n_predict,
			t_max_predict_ms: req.t_max_predict_ms,
			temperature: req.temperature,
			top_p: req.top_p,
			top_k: req.top_k,
			cache_prompt: true,
			n_cache_reuse: 256,
			stream: true,
			timings_per_token: true,
		});

		const res = await this.open(payload);
		if (res.statusCode !== 200) {
			const body = await readAll(res);
			throw new InfillError(`/infill returned ${res.statusCode}: ${body.slice(0, 500)}`);
		}

		const decoder = new LineDecoder();
		const parts: string[] = [];
		let stopType: string | null = null;
		let timings: Record<string, number> = {};
		let superseded = false;
		let done = false;

		const onAbort = () => res.destroy();
		opts.signal?.addEventListener('abort', onAbort, { once: true });

		try {
			outer: for await (const chunk of res) {
				for (const line of decoder.push(chunk as Uint8Array)) {
					if (!line.startsWith('data:')) {
						continue;
					}
					if (opts.shouldStop?.()) {
						superseded = true;
						break outer;
					}
					let frame: Record<string, unknown>;
					try {
						frame = JSON.parse(line.slice(5)) as Record<string, unknown>;
					} catch {
						opts.log?.(`undecodable /infill frame: ${line.slice(0, 200)}`);
						continue;
					}
					// After the stop frame we keep draining rather than breaking, so the
					// socket ends cleanly and returns to the keep-alive pool -- but we
					// stop accumulating, in case anything trails it.
					if (done) {
						continue;
					}
					if (typeof frame.content === 'string') {
						parts.push(frame.content);
					}
					if (frame.stop) {
						stopType = typeof frame.stop_type === 'string' ? frame.stop_type : null;
						timings = (frame.timings as Record<string, number>) ?? {};
						done = true;
					}
				}
			}
		} catch (err) {
			// A destroyed stream is how an abort surfaces, and it is expected.
			if (!opts.signal?.aborted) {
				throw err;
			}
			superseded = true;
		} finally {
			opts.signal?.removeEventListener('abort', onAbort);
		}

		if (superseded) {
			// Destroy rather than drain: the point is to stop llama-server
			// generating, not to collect the rest politely.
			res.destroy();
		}

		return { content: parts.join(''), stopType, superseded, timings };
	}

	private open(payload: string): Promise<http.IncomingMessage> {
		return new Promise((resolve, reject) => {
			const url = new URL('/infill', this.baseUrl);
			const req = http.request(
				{
					hostname: url.hostname,
					port: url.port,
					path: '/infill',
					method: 'POST',
					agent: this.agent,
					headers: {
						'content-type': 'application/json',
						'content-length': Buffer.byteLength(payload),
					},
				},
				(res) => {
					// Disarm: generation length is bounded by n_predict and
					// t_max_predict_ms, not by the clock. The timeout above covers
					// connect and headers only, so a slow generation is never cut off.
					req.setTimeout(0);
					resolve(res);
				},
			);
			req.setTimeout(this.connectTimeoutMs, () => {
				req.destroy(
					new InfillError(`/infill: no response within ${this.connectTimeoutMs}ms`),
				);
			});
			req.on('error', reject);
			req.end(payload);
		});
	}
}
