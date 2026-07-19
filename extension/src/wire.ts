/**
 * The extension <-> server contract, shared by both sides.
 *
 * This file is the whole reason the sidecar lives in the extension package: the
 * client and the server import the same types, so a contract change that only
 * lands on one side is a compile error rather than a runtime surprise. It was
 * previously duplicated between `client/http.ts` and the server's `schemas.py`,
 * kept in step by hand.
 *
 * The wire is snake_case; the extension's own surfaces are camelCase. That
 * remapping lives in `client/http.ts` and stays there.
 *
 * No `vscode` import, and none is possible: this is compiled into the sidecar
 * bundle, which has no extension host.
 */

export interface CompleteRequest {
	/**
	 * Stable per-document id (the document URI). Scopes superseding, so two
	 * editors typing at once do not abort each other.
	 */
	session_id: string;
	/** Text before the cursor. The server truncates; send what you have. */
	prefix: string;
	/** Text after the cursor. */
	suffix: string;
	/** VS Code languageId, e.g. 'typescript'. */
	language_id: string;
	/** Absolute path of the current file. */
	path: string;
	/**
	 * Paths of other open documents, most-recent first. Paths only -- the server
	 * reads and chunks them itself. Used for cross-file context.
	 */
	open_paths: string[];
}

export interface CompleteResponse {
	completion: string;
	cached: boolean;
	/**
	 * True when a newer keystroke landed before this one finished. The extension
	 * should render nothing; a newer request is already in flight.
	 *
	 * Deliberately overloaded across stale-before-lock, stale-after-lock and
	 * client disconnect: it answers "should I render this?", not "does a newer
	 * request exist?".
	 */
	superseded: boolean;
	stop_type: string | null;
	timings: Record<string, number>;
}

/** Reports an accepted completion, to be retrieved as a few-shot example later. */
export interface AcceptRequest {
	prefix: string;
	completion: string;
	language_id: string;
}

export interface AcceptResponse {
	examples: number;
}

export interface HealthResponse {
	status: string;
	llama: string;
	cache_entries: number;
	cache_hits: number;
	cache_misses: number;
}

/**
 * Request validation.
 *
 * Replaces pydantic. Hand-rolled rather than reaching for zod: the sidecar
 * staying free of third-party runtime code is worth more than the ergonomics,
 * and there are exactly two request bodies.
 */
export class InvalidRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InvalidRequestError';
	}
}

function asRecord(body: unknown): Record<string, unknown> {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		throw new InvalidRequestError('body must be a JSON object');
	}
	return body as Record<string, unknown>;
}

/**
 * Read an own property only. `JSON.parse` produces solely own properties, so over
 * network input this is equivalent to `obj[field]` -- but reading through the
 * prototype chain would let an inherited value satisfy a required field if this
 * parser were ever fed an object built another way. Cheap to close now.
 */
function own(obj: Record<string, unknown>, field: string): unknown {
	return Object.hasOwn(obj, field) ? obj[field] : undefined;
}

function requiredString(obj: Record<string, unknown>, field: string): string {
	const v = own(obj, field);
	if (typeof v !== 'string') {
		throw new InvalidRequestError(`${field} is required and must be a string`);
	}
	return v;
}

/**
 * Like `requiredString`, but `''` is also rejected. Only `session_id` uses this:
 * it is the supersede scope, and an empty one collapses every document into a
 * single scope, which is exactly the cross-document abort per-session superseding
 * exists to prevent. A real client always sends the document URI. Empty `prefix`
 * stays legal -- the cursor at offset 0 is an empty prefix -- so this is not a
 * blanket non-empty rule.
 */
function requiredNonEmptyString(obj: Record<string, unknown>, field: string): string {
	const v = requiredString(obj, field);
	if (v === '') {
		throw new InvalidRequestError(`${field} must not be empty`);
	}
	return v;
}

function optionalString(obj: Record<string, unknown>, field: string): string {
	const v = own(obj, field);
	if (v === undefined || v === null) {
		return '';
	}
	if (typeof v !== 'string') {
		throw new InvalidRequestError(`${field} must be a string`);
	}
	return v;
}

function optionalStringArray(obj: Record<string, unknown>, field: string): string[] {
	const v = own(obj, field);
	if (v === undefined || v === null) {
		return [];
	}
	if (!Array.isArray(v) || v.some((item) => typeof item !== 'string')) {
		throw new InvalidRequestError(`${field} must be an array of strings`);
	}
	return v as string[];
}

export function parseCompleteRequest(body: unknown): CompleteRequest {
	const obj = asRecord(body);
	return {
		session_id: requiredNonEmptyString(obj, 'session_id'),
		prefix: requiredString(obj, 'prefix'),
		suffix: optionalString(obj, 'suffix'),
		language_id: optionalString(obj, 'language_id'),
		path: optionalString(obj, 'path'),
		open_paths: optionalStringArray(obj, 'open_paths'),
	};
}

export function parseAcceptRequest(body: unknown): AcceptRequest {
	const obj = asRecord(body);
	return {
		prefix: requiredString(obj, 'prefix'),
		completion: requiredString(obj, 'completion'),
		language_id: optionalString(obj, 'language_id'),
	};
}
