/**
 * Settings for the Emberline inference server.
 *
 * Env-only, prefix `EMBERLINE__`. Deliberately *not* backed by a JSON file that
 * overrides the environment -- for a server, env > file is the precedence people
 * expect. A `.env` in the working directory is read first, then real environment
 * variables win over it.
 */

import * as os from 'node:os';
import * as path from 'node:path';

export interface Settings {
	// --- emberline's own HTTP surface ---
	host: string;
	port: number;

	// --- llama-server subprocess ---
	/** Path to the llama-server executable, or a bare name on PATH. */
	llamaBinary: string;
	llamaHost: string;
	llamaPort: number;
	/**
	 * llama.cpp FIM preset. Sets model, n_batch=1024, n_ubatch=1024,
	 * n_cache_reuse=256. Base M1 with 16GB should stay at 1.5b.
	 */
	llamaPreset: string;
	llamaExtraArgs: string[];
	/** If false, assume llama-server is already running at llamaHost:llamaPort. */
	llamaManaged: boolean;
	/** Cold start includes a model download on first run, so this is generous. */
	llamaStartupTimeoutS: number;

	// --- generation budget ---
	nPredict: number;
	/**
	 * Upstream's stated FIM target is ~1s end to end. Only bites after the first
	 * token AND after a newline has been generated -- it is not a hard cap.
	 */
	tMaxPredictMs: number;
	temperature: number;
	topP: number;
	topK: number;

	// --- context budget ---
	maxPrefixChars: number;
	/**
	 * llama.cpp clamps prefix:suffix to 3:1 of n_batch regardless of what we send,
	 * so sending more than this is wasted serialization.
	 */
	maxSuffixChars: number;

	// --- cache ---
	/** llama.vim ships 250; no reason to differ. */
	cacheMaxEntries: number;

	// --- lifetime ---
	/**
	 * Exit after this long with no completion traffic. 0 disables.
	 *
	 * This is what lets the editor start a server and never kill one. The process
	 * is shared: a second VS Code window reuses it rather than spawning its own, so
	 * whichever window happened to start it must not own it. It is also warm on
	 * purpose -- the KV cache is the whole point -- so tying it to a window's
	 * lifetime would throw away the design.
	 */
	idleTimeoutS: number;

	// --- cross-file ring buffer context ---
	ringEnabled: boolean;
	ringMaxChunks: number;
	ringChunkLines: number;

	// --- accepted-example retrieval ---
	examplesEnabled: boolean;
	examplesTopK: number;
	/**
	 * Jaccard over identifier tokens, NOT the cosine threshold the embedding-backed
	 * store used -- the scales are unrelated. See docs/typescript-migration.md §1.4.
	 *
	 * Measured on a 423-example corpus of this repo's own source (see the tuning
	 * note in that document): same-context pairs score p50 0.18, unrelated pairs
	 * p99 0.16, so the distributions overlap and the choice is a precision/recall
	 * trade rather than a clean cut. At 0.15 retrieval fires on 99.8% of queries at
	 * 69% precision; 0.25 maximises F1 (79% precision, 93% recall) but drops the
	 * share of correct *cross-file* matches from 57% to 39%, and cross-file is the
	 * case worth having. Hence 0.15.
	 */
	examplesMinSimilarity: number;
	/** Cap on rows kept; the store is scanned linearly in memory. */
	examplesMaxRows: number;

	dataDir: string;
}

export const DEFAULTS: Settings = {
	host: '127.0.0.1',
	port: 8011,

	llamaBinary: 'llama-server',
	llamaHost: '127.0.0.1',
	llamaPort: 8012,
	llamaPreset: '--fim-qwen-1.5b-default',
	llamaExtraArgs: [],
	llamaManaged: true,
	llamaStartupTimeoutS: 300,

	nPredict: 128,
	tMaxPredictMs: 1000,
	temperature: 0.1,
	topP: 0.9,
	topK: 40,

	maxPrefixChars: 8192,
	maxSuffixChars: 2048,

	cacheMaxEntries: 250,

	idleTimeoutS: 1800,

	ringEnabled: true,
	ringMaxChunks: 16,
	ringChunkLines: 64,

	examplesEnabled: true,
	examplesTopK: 3,
	examplesMinSimilarity: 0.15,
	examplesMaxRows: 2000,

	dataDir: path.join(os.homedir(), '.emberline'),
};

/** Environment variable name for a settings field: `topK` -> `EMBERLINE__TOP_K`. */
function envName(field: string): string {
	return `EMBERLINE__${field.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;
}

/** Same spellings pydantic-settings accepted, so existing setups keep working. */
function parseBool(raw: string, name: string): boolean {
	const v = raw.trim().toLowerCase();
	if (['1', 'true', 'yes', 'on', 't', 'y'].includes(v)) {
		return true;
	}
	if (['0', 'false', 'no', 'off', 'f', 'n'].includes(v)) {
		return false;
	}
	throw new Error(`${name}: expected a boolean, got ${JSON.stringify(raw)}`);
}

/**
 * `Number()` is too permissive for a config surface. It maps '' and '   ' to 0
 * (so `EMBERLINE__PORT=` -- an exported-but-unset shell var -- silently bound port
 * 0), and it accepts 0x/0o/0b/underscore forms (so `PORT=0x10` silently became
 * 16). A decimal-only grammar admits exactly the spellings a human writes for a
 * setting: optional sign, digits, one decimal point, an exponent.
 */
const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

function parseNumber(raw: string, name: string): number {
	const trimmed = raw.trim();
	const n = DECIMAL_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
	if (!Number.isFinite(n)) {
		throw new Error(`${name}: expected a decimal number, got ${JSON.stringify(raw)}`);
	}
	return n;
}

interface Bound {
	min?: number;
	max?: number;
	int?: boolean;
}

/**
 * Range and integrality per numeric field, applied after parsing so a bad value
 * fails at startup naming the variable, rather than surfacing later as an opaque
 * EADDRINUSE/EACCES on a nonsense port or -- the case that motivated this --
 * `ringChunkLines: 0` wedging the chunk loop in ring.ts (it increments by that
 * value) into an infinite loop that never yields the event loop back.
 *
 * `port` forbids 0 deliberately: it is the OS "pick an ephemeral port" idiom, but
 * nothing here configures it that way, and allowing it re-opens the door next to
 * the empty-string bug this file just closed.
 */
const BOUNDS: Partial<Record<keyof Settings, Bound>> = {
	port: { min: 1, max: 65535, int: true },
	llamaPort: { min: 1, max: 65535, int: true },
	llamaStartupTimeoutS: { min: 0 },
	nPredict: { min: 1, int: true },
	tMaxPredictMs: { min: 0 },
	temperature: { min: 0, max: 2 },
	topP: { min: 0, max: 1 },
	topK: { min: 0, int: true },
	maxPrefixChars: { min: 0, int: true },
	maxSuffixChars: { min: 0, int: true },
	cacheMaxEntries: { min: 0, int: true },
	idleTimeoutS: { min: 0 },
	ringMaxChunks: { min: 0, int: true },
	ringChunkLines: { min: 1, int: true },
	examplesTopK: { min: 0, int: true },
	examplesMinSimilarity: { min: 0, max: 1 },
	examplesMaxRows: { min: 0, int: true },
};

function checkBound(key: keyof Settings, n: number, name: string): number {
	const b = BOUNDS[key];
	if (b === undefined) {
		return n;
	}
	if (b.int && !Number.isInteger(n)) {
		throw new Error(`${name}: expected an integer, got ${n}`);
	}
	if (b.min !== undefined && n < b.min) {
		throw new Error(`${name}: must be >= ${b.min}, got ${n}`);
	}
	if (b.max !== undefined && n > b.max) {
		throw new Error(`${name}: must be <= ${b.max}, got ${n}`);
	}
	return n;
}

/**
 * pydantic-settings parsed list-typed variables as JSON. Kept, with a
 * whitespace-split fallback so `EMBERLINE__LLAMA_EXTRA_ARGS="-ngl 99"` also works.
 */
function parseList(raw: string, name: string): string[] {
	const trimmed = raw.trim();
	if (!trimmed) {
		return [];
	}
	if (trimmed.startsWith('[')) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			throw new Error(`${name}: expected a JSON array, got ${JSON.stringify(raw)}`);
		}
		if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
			throw new Error(`${name}: expected an array of strings`);
		}
		return parsed as string[];
	}
	return trimmed.split(/\s+/);
}

/**
 * String fields where an empty value is a real choice rather than a mistake.
 * `llamaPreset` can legitimately be blanked to drive everything through
 * `llamaExtraArgs`. Every other string field ('' host, '' binary, '' dataDir) is
 * the exported-but-unset shell var again, and taking it literally clobbers a
 * working default -- so it fails instead.
 */
const EMPTY_STRING_OK = new Set<keyof Settings>(['llamaPreset']);

export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
	const out = { ...DEFAULTS };
	for (const key of Object.keys(DEFAULTS) as Array<keyof Settings>) {
		const name = envName(key);
		const raw = env[name];
		if (raw === undefined) {
			continue;
		}
		const current = DEFAULTS[key];
		if (typeof current === 'boolean') {
			(out[key] as boolean) = parseBool(raw, name);
		} else if (typeof current === 'number') {
			(out[key] as number) = checkBound(key, parseNumber(raw, name), name);
		} else if (Array.isArray(current)) {
			(out[key] as string[]) = parseList(raw, name);
		} else {
			if (raw === '' && !EMPTY_STRING_OK.has(key)) {
				throw new Error(`${name}: must not be empty`);
			}
			(out[key] as string) = raw;
		}
	}
	return out;
}

export function llamaUrl(s: Settings): string {
	return `http://${s.llamaHost}:${s.llamaPort}`;
}

/** Accepted examples, one JSON object per line. Appended on accept. */
export function examplesPath(s: Settings): string {
	return path.join(s.dataDir, 'examples.jsonl');
}

/**
 * Where llama-server downloads GGUF models.
 *
 * Keeps everything Emberline owns under one directory rather than mixing our
 * model into the shared `~/.cache/huggingface` alongside unrelated ones.
 * llama.cpp appends `/hub` to this, giving the standard HF cache layout.
 */
export function hfHome(s: Settings): string {
	return path.join(s.dataDir, 'cache', 'huggingface');
}

export function logPath(s: Settings): string {
	return path.join(s.dataDir, 'server.log');
}

/** Cache-key component: changing sampling must not serve stale completions. */
export function paramsDigestInput(s: Settings): string {
	return `${s.llamaPreset}|${s.nPredict}|${s.temperature}|${s.topP}|${s.topK}`;
}
