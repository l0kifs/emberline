/**
 * HTTP surface.
 *
 * Non-streaming: the inline completion API wants one string, not a stream.
 *
 * The Python server had to poll `request.is_disconnected()` and race it against
 * the generation, because uvicorn does not cancel a plain `async def` handler
 * when the client goes away. `node:http` gives us the disconnect directly as a
 * 'close' event, so that whole mechanism is gone -- but what it was protecting is
 * not: an abandoned keystroke must never hold the global model lock for a full
 * generation.
 */

import * as http from 'node:http';

import {
	type AcceptResponse,
	type CompleteResponse,
	type HealthResponse,
	InvalidRequestError,
	parseAcceptRequest,
	parseCompleteRequest,
} from '../wire';
import type { Assembler } from './assemble';
import { type CompletionCache, contextKey } from './cache';
import { llamaUrl, type Settings } from './config';
import { getStatus } from './httpc';
import type { IdleShutdown } from './idle';
import type { InfillClient } from './infill';
import { trimCompletion } from './postprocess';
import type { Supersede } from './supersede';

/** What every route needs. Built once in main.ts; there is no DI container. */
export interface EngineContext {
	settings: Settings;
	infill: InfillClient;
	cache: CompletionCache;
	supersede: Supersede;
	assembler: Assembler;
	examples: {
		add(args: { prefix: string; completion: string; languageId: string }): Promise<void>;
		count(): number;
	} | null;
	paramsDigest: string;
	idle: IdleShutdown;
	log: (message: string) => void;
}

/** Generous: prefix and suffix are clamped server-side, but by the assembler. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const HEALTH_TIMEOUT_MS = 1000;

const EMPTY_COMPLETION: CompleteResponse = {
	completion: '',
	cached: false,
	superseded: true,
	stop_type: null,
	timings: {},
};

function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new InvalidRequestError('request body too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			const raw = Buffer.concat(chunks).toString('utf8');
			try {
				resolve(JSON.parse(raw));
			} catch {
				reject(new InvalidRequestError('body is not valid JSON'));
			}
		});
		req.on('error', reject);
	});
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
	// The client may already be gone; writing to a closed response is not an error
	// worth logging, it is the normal shape of a typed-through keystroke.
	if (res.writableEnded || res.destroyed) {
		return;
	}
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json',
		'content-length': Buffer.byteLength(payload),
	});
	res.end(payload);
}

async function handleComplete(
	ctx: EngineContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const body = await readBody(req);

	// Everything from here to the first await is one synchronous block, and it has
	// to stay that way: claiming a generation before any await is what makes an
	// older in-flight request see itself go stale the moment this one is parsed.
	const parsed = parseCompleteRequest(body);
	ctx.idle.touch();
	const generation = ctx.supersede.claim(parsed.session_id);

	// A disconnect is a 'close' before the response was written. Both halves
	// matter: `disconnected` stops the generation at its next frame, and the
	// abort tears down the /infill stream immediately, so we do not release the
	// model lock while llama-server is still busy.
	let disconnected = false;
	const abort = new AbortController();
	res.on('close', () => {
		if (!res.writableEnded) {
			disconnected = true;
			abort.abort();
		}
	});

	const { req: infillReq, extraDigest } = await ctx.assembler.build({
		prefix: parsed.prefix,
		suffix: parsed.suffix,
		languageId: parsed.language_id,
		path: parsed.path,
		openPaths: parsed.open_paths,
	});

	const key = contextKey(infillReq.prefix, infillReq.suffix, extraDigest, ctx.paramsDigest);
	const cached = ctx.cache.get(key);
	if (cached !== undefined) {
		// A cache hit ignores staleness on purpose: the answer is already correct
		// for this context and costs nothing to return.
		sendJson(res, 200, {
			completion: cached,
			cached: true,
			superseded: false,
			stop_type: null,
			timings: {},
		} satisfies CompleteResponse);
		return;
	}

	const shouldStop = () => disconnected || ctx.supersede.isStale(parsed.session_id, generation);

	if (shouldStop()) {
		sendJson(res, 200, EMPTY_COMPLETION);
		return;
	}

	const result = await ctx.supersede.modelLock.runExclusive(async () => {
		// Re-check: the user almost certainly typed again while we queued.
		if (shouldStop()) {
			return null;
		}
		return ctx.infill.infill(infillReq, {
			shouldStop,
			signal: abort.signal,
			log: ctx.log,
		});
	});

	if (result === null || result.superseded) {
		sendJson(res, 200, EMPTY_COMPLETION);
		return;
	}

	const text = trimCompletion(result.content, infillReq.suffix);
	if (text) {
		ctx.cache.put(key, text);
	}
	sendJson(res, 200, {
		completion: text,
		cached: false,
		superseded: false,
		stop_type: result.stopType,
		timings: Object.fromEntries(
			Object.entries(result.timings).filter(([k]) =>
				['prompt_n', 'prompt_ms', 'predicted_n', 'predicted_ms'].includes(k),
			),
		),
	} satisfies CompleteResponse);
}

async function handleAccept(
	ctx: EngineContext,
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<void> {
	const parsed = parseAcceptRequest(await readBody(req));
	ctx.idle.touch();
	if (ctx.examples === null) {
		sendJson(res, 200, { examples: 0 } satisfies AcceptResponse);
		return;
	}
	await ctx.examples.add({
		prefix: parsed.prefix,
		completion: parsed.completion,
		languageId: parsed.language_id,
	});
	sendJson(res, 200, { examples: ctx.examples.count() } satisfies AcceptResponse);
}

async function handleHealth(ctx: EngineContext, res: http.ServerResponse): Promise<void> {
	// Deliberately does NOT touch the idle timer. A liveness probe means someone
	// is watching, not that anyone is typing; counting probes as activity would
	// defeat the timeout for exactly the abandoned-editor case it exists for.
	const ok = (await getStatus(`${llamaUrl(ctx.settings)}/health`, HEALTH_TIMEOUT_MS)) === 200;
	sendJson(res, 200, {
		status: ok ? 'ok' : 'degraded',
		llama: ok ? 'ok' : 'unreachable',
		cache_entries: ctx.cache.size,
		cache_hits: ctx.cache.hits,
		cache_misses: ctx.cache.misses,
	} satisfies HealthResponse);
}

export function createServer(ctx: EngineContext): http.Server {
	const server = http.createServer((req, res) => {
		const route = async () => {
			if (req.method === 'POST' && req.url === '/v1/complete') {
				return handleComplete(ctx, req, res);
			}
			if (req.method === 'POST' && req.url === '/v1/accept') {
				return handleAccept(ctx, req, res);
			}
			if (req.method === 'GET' && req.url === '/health') {
				return handleHealth(ctx, res);
			}
			sendJson(res, 404, { detail: 'not found' });
		};

		route().catch((err: unknown) => {
			if (err instanceof InvalidRequestError) {
				sendJson(res, 422, { detail: err.message });
				return;
			}
			ctx.log(`unhandled error on ${req.method} ${req.url}: ${String(err)}`);
			sendJson(res, 500, { detail: 'internal error' });
		});
	});

	// Mirrors uvicorn's timeout_keep_alive=120, keeping the editor's TCP
	// connection warm between keystrokes. headersTimeout must stay above
	// keepAliveTimeout or Node closes sockets out from under the client.
	server.keepAliveTimeout = 125_000;
	server.headersTimeout = 130_000;
	return server;
}
