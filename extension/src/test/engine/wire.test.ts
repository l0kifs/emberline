/**
 * `wire.ts` is the server's entire request-validation surface: every byte that
 * reaches `engine/http.ts` from the network passes through these two functions
 * and nothing else. Validation is hand-rolled rather than zod (the sidecar
 * bundle stays free of third-party runtime code), which means the checks are
 * ours to regression-guard.
 *
 * House style: every test names the bug it guards against.
 */

import * as assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { InvalidRequestError, parseAcceptRequest, parseCompleteRequest } from '../../wire';

/** A minimal valid /v1/complete body, to be spread and overridden per test. */
function complete(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { session_id: 'file:///a.ts', prefix: 'const x = ', ...overrides };
}

/** A minimal valid /v1/accept body. */
function accept(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { prefix: 'const x = ', completion: '1;', ...overrides };
}

describe('parseCompleteRequest: body shape', () => {
	// An array is typeof 'object', so a bare `typeof body !== 'object'` check
	// would let it through and every field would read as undefined.
	it('rejects an array body', () => {
		assert.throws(() => parseCompleteRequest([]), /body must be a JSON object/);
	});

	// null is also typeof 'object'; without the explicit null check this is a
	// TypeError on property access rather than a 400.
	it('rejects a null body', () => {
		assert.throws(() => parseCompleteRequest(null), /body must be a JSON object/);
	});

	it('rejects a string body', () => {
		assert.throws(() => parseCompleteRequest('session_id'), /body must be a JSON object/);
	});

	it('rejects a number body', () => {
		assert.throws(() => parseCompleteRequest(42), /body must be a JSON object/);
	});

	it('rejects an undefined body', () => {
		assert.throws(() => parseCompleteRequest(undefined), /body must be a JSON object/);
	});
});

describe('parseCompleteRequest: session_id', () => {
	it('rejects a missing session_id', () => {
		assert.throws(() => parseCompleteRequest({ prefix: 'p' }), /session_id/);
	});

	it('rejects a null session_id', () => {
		assert.throws(() => parseCompleteRequest(complete({ session_id: null })), /session_id/);
	});

	it('rejects a numeric session_id', () => {
		assert.throws(() => parseCompleteRequest(complete({ session_id: 7 })), /session_id/);
	});

	it('rejects a boolean session_id', () => {
		assert.throws(() => parseCompleteRequest(complete({ session_id: true })), /session_id/);
	});

	it('rejects an object session_id', () => {
		assert.throws(() => parseCompleteRequest(complete({ session_id: { uri: 'a' } })), /session_id/);
	});

	it('rejects an array session_id', () => {
		assert.throws(() => parseCompleteRequest(complete({ session_id: ['a'] })), /session_id/);
	});

	it('rejects an empty session_id', () => {
		// session_id is the supersede scope, so '' collapses every document into one
		// scope and two editors typing at once abort each other -- exactly the failure
		// per-session superseding exists to prevent. A real client always sends the
		// document URI, so an empty one can only be a malformed request.
		assert.throws(() => parseCompleteRequest(complete({ session_id: '' })), /session_id/);
	});

	it('still accepts an empty prefix', () => {
		// The empty-session_id rejection must not become a blanket non-empty rule: an
		// empty prefix is legitimate -- the cursor at offset 0 of a file has one.
		assert.equal(parseCompleteRequest(complete({ prefix: '' })).prefix, '');
	});
});

describe('parseCompleteRequest: prefix', () => {
	it('rejects a missing prefix', () => {
		assert.throws(() => parseCompleteRequest({ session_id: 's' }), /prefix/);
	});

	it('rejects a null prefix', () => {
		assert.throws(() => parseCompleteRequest(complete({ prefix: null })), /prefix/);
	});

	it('rejects a numeric prefix', () => {
		assert.throws(() => parseCompleteRequest(complete({ prefix: 0 })), /prefix/);
	});

	it('rejects a boolean prefix', () => {
		assert.throws(() => parseCompleteRequest(complete({ prefix: false })), /prefix/);
	});

	it('rejects an object prefix', () => {
		assert.throws(() => parseCompleteRequest(complete({ prefix: { text: 'p' } })), /prefix/);
	});

	it('rejects an array prefix', () => {
		assert.throws(() => parseCompleteRequest(complete({ prefix: ['p'] })), /prefix/);
	});

	it('accepts an empty prefix', () => {
		// Unlike an empty session_id this is entirely defensible: the cursor at
		// offset 0 of a new file legitimately has nothing before it, and FIM with
		// an empty prefix is a normal request. Rejecting it would kill completions
		// at the top of every file.
		assert.equal(parseCompleteRequest(complete({ prefix: '' })).prefix, '');
	});
});

describe('parseCompleteRequest: optional strings', () => {
	for (const field of ['suffix', 'language_id', 'path']) {
		it(`defaults ${field} to '' when absent`, () => {
			const parsed = parseCompleteRequest(complete()) as unknown as Record<string, string>;
			assert.equal(parsed[field], '');
		});

		it(`defaults ${field} to '' when null`, () => {
			// JSON.stringify of an undefined-valued field drops it, but a client that
			// sends an explicit null must not produce the string 'null' downstream.
			const parsed = parseCompleteRequest(complete({ [field]: null })) as unknown as Record<
				string,
				string
			>;
			assert.equal(parsed[field], '');
		});

		it(`rejects a numeric ${field}`, () => {
			assert.throws(
				() => parseCompleteRequest(complete({ [field]: 1 })),
				new RegExp(`${field} must be a string`),
			);
		});

		it(`rejects an object ${field}`, () => {
			assert.throws(
				() => parseCompleteRequest(complete({ [field]: {} })),
				new RegExp(`${field} must be a string`),
			);
		});

		it(`passes a well-formed ${field} through`, () => {
			const parsed = parseCompleteRequest(complete({ [field]: 'v' })) as unknown as Record<
				string,
				string
			>;
			assert.equal(parsed[field], 'v');
		});
	}
});

describe('parseCompleteRequest: open_paths', () => {
	it('defaults to an empty array when absent', () => {
		assert.deepEqual(parseCompleteRequest(complete()).open_paths, []);
	});

	it('defaults to an empty array when null', () => {
		assert.deepEqual(parseCompleteRequest(complete({ open_paths: null })).open_paths, []);
	});

	it('accepts an explicitly empty array', () => {
		assert.deepEqual(parseCompleteRequest(complete({ open_paths: [] })).open_paths, []);
	});

	it('accepts an array of paths verbatim', () => {
		const paths = ['/a/b.ts', '/c/d.py'];
		assert.deepEqual(parseCompleteRequest(complete({ open_paths: paths })).open_paths, paths);
	});

	it('rejects a string open_paths', () => {
		// A single path sent unwrapped: without the Array.isArray check this would
		// be spread into one ring entry per character.
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: '/a/b.ts' })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects an object open_paths', () => {
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: { 0: '/a.ts' } })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects a numeric open_paths', () => {
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: 3 })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects an array containing a number', () => {
		// Element types matter: `engine/ring.ts` hands each entry straight to the
		// filesystem, and a non-string there throws inside retrieval instead of
		// being reported as a bad request.
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: ['/a.ts', 2] })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects an array containing null', () => {
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: ['/a.ts', null] })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects an array containing a nested array', () => {
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: [['/a.ts']] })),
			/open_paths must be an array of strings/,
		);
	});

	it('rejects an array containing an object', () => {
		assert.throws(
			() => parseCompleteRequest(complete({ open_paths: [{ path: '/a.ts' }] })),
			/open_paths must be an array of strings/,
		);
	});
});

describe('parseCompleteRequest: content passthrough', () => {
	// The payload is source code, not user prose: any sanitising, escaping or
	// normalising here corrupts the prompt and the model completes garbage. Each
	// of these must round-trip byte for byte.
	const cases: Array<[string, string]> = [
		['unicode and emoji', 'const 変数 = "🔥🚀";\n'],
		['an apostrophe', "const name = 'O'Brian';"],
		['a SQL-injection-looking string', "'; DROP TABLE users; --"],
		['an HTML script tag', '<script>alert("xss")</script>'],
		['a lone surrogate', 'emoji: \ud83d'],
		['a NUL character', 'a\u0000b'],
		['whitespace only', '   \t\n  '],
		['a backslash run', 'const re = /\\\\d+\\\\n/;'],
	];

	for (const [label, text] of cases) {
		it(`preserves ${label} in prefix`, () => {
			assert.equal(parseCompleteRequest(complete({ prefix: text })).prefix, text);
		});
	}

	it('preserves a lone surrogate in suffix', () => {
		// Related to the contextKey UTF-16LE bug: the extension slices the document
		// by offset, so a cursor inside a surrogate pair really does produce these
		// and validation must not quietly replace them with U+FFFD.
		assert.equal(parseCompleteRequest(complete({ suffix: '\ude00 rest' })).suffix, '\ude00 rest');
	});
});

describe('parseCompleteRequest: object hygiene', () => {
	it('does not pollute Object.prototype via a __proto__ key', () => {
		// JSON.parse makes "__proto__" a plain own property rather than a setter,
		// so the parser reading obj[field] is safe -- but only as long as nothing
		// here copies keys with assignment or a spread-into-fresh-object helper.
		const body = JSON.parse(
			'{"session_id":"s","prefix":"p","__proto__":{"polluted":"yes"}}',
		) as unknown;
		parseCompleteRequest(body);
		assert.equal((Object.prototype as unknown as Record<string, unknown>).polluted, undefined);
		assert.equal(({} as unknown as Record<string, unknown>).polluted, undefined);
	});

	it('parses a body carrying a __proto__ key without crashing', () => {
		const body = JSON.parse(
			'{"session_id":"s","prefix":"p","__proto__":{"session_id":"attacker"}}',
		) as unknown;
		const parsed = parseCompleteRequest(body);
		assert.equal(parsed.session_id, 's');
		assert.equal(parsed.prefix, 'p');
	});

	it('does not resolve fields through the prototype chain', () => {
		// The helpers read own properties only, so an inherited value cannot satisfy
		// a required field. Unreachable from the network -- JSON.parse only ever
		// produces own properties -- but it keeps the parser safe to reuse on objects
		// built another way.
		const body = Object.create({ prefix: 'inherited-from-prototype' }) as Record<string, unknown>;
		body.session_id = 's';
		assert.throws(() => parseCompleteRequest(body), /prefix/);
	});

	it('ignores unknown fields rather than echoing or rejecting them', () => {
		// The parser returns a fresh object with exactly the contract's keys, so an
		// old or newer client sending extra fields is compatible in both directions.
		const parsed = parseCompleteRequest(
			complete({ temperature: 0.9, n_predict: 999, nonsense: { a: 1 } }),
		);
		assert.deepEqual(Object.keys(parsed).sort(), [
			'language_id',
			'open_paths',
			'path',
			'prefix',
			'session_id',
			'suffix',
		]);
	});

	it('returns every contract field on a minimal body', () => {
		assert.deepEqual(parseCompleteRequest(complete()), {
			session_id: 'file:///a.ts',
			prefix: 'const x = ',
			suffix: '',
			language_id: '',
			path: '',
			open_paths: [],
		});
	});
});

describe('parseAcceptRequest: body shape', () => {
	it('rejects an array body', () => {
		assert.throws(() => parseAcceptRequest([]), /body must be a JSON object/);
	});

	it('rejects a null body', () => {
		assert.throws(() => parseAcceptRequest(null), /body must be a JSON object/);
	});

	it('rejects a string body', () => {
		assert.throws(() => parseAcceptRequest('prefix'), /body must be a JSON object/);
	});

	it('rejects a number body', () => {
		assert.throws(() => parseAcceptRequest(1), /body must be a JSON object/);
	});
});

describe('parseAcceptRequest: prefix', () => {
	it('rejects a missing prefix', () => {
		assert.throws(() => parseAcceptRequest({ completion: 'c' }), /prefix/);
	});

	it('rejects a null prefix', () => {
		assert.throws(() => parseAcceptRequest(accept({ prefix: null })), /prefix/);
	});

	it('rejects a numeric prefix', () => {
		assert.throws(() => parseAcceptRequest(accept({ prefix: 5 })), /prefix/);
	});

	it('rejects a boolean prefix', () => {
		assert.throws(() => parseAcceptRequest(accept({ prefix: true })), /prefix/);
	});

	it('rejects an object prefix', () => {
		assert.throws(() => parseAcceptRequest(accept({ prefix: {} })), /prefix/);
	});

	it('accepts an empty prefix', () => {
		assert.equal(parseAcceptRequest(accept({ prefix: '' })).prefix, '');
	});
});

describe('parseAcceptRequest: completion', () => {
	it('rejects a missing completion', () => {
		assert.throws(() => parseAcceptRequest({ prefix: 'p' }), /completion/);
	});

	it('rejects a null completion', () => {
		assert.throws(() => parseAcceptRequest(accept({ completion: null })), /completion/);
	});

	it('rejects a numeric completion', () => {
		assert.throws(() => parseAcceptRequest(accept({ completion: 3 })), /completion/);
	});

	it('rejects a boolean completion', () => {
		assert.throws(() => parseAcceptRequest(accept({ completion: false })), /completion/);
	});

	it('rejects an array completion', () => {
		assert.throws(() => parseAcceptRequest(accept({ completion: ['c'] })), /completion/);
	});

	it('accepts an empty completion', () => {
		// Deliberate: validation only decides "is this a well-formed request", and
		// an empty completion is. Whether it is worth storing is ExampleStore.add's
		// call, and that is where whitespace-only completions are dropped. Moving
		// the emptiness rule up here would turn a benign no-op into a 400 that the
		// extension surfaces as a failure.
		assert.equal(parseAcceptRequest(accept({ completion: '' })).completion, '');
	});

	it('accepts a whitespace-only completion', () => {
		assert.equal(parseAcceptRequest(accept({ completion: '\n\t' })).completion, '\n\t');
	});
});

describe('parseAcceptRequest: language_id', () => {
	it("defaults to '' when absent", () => {
		assert.equal(parseAcceptRequest(accept()).language_id, '');
	});

	it("defaults to '' when null", () => {
		assert.equal(parseAcceptRequest(accept({ language_id: null })).language_id, '');
	});

	it('rejects a numeric language_id', () => {
		assert.throws(
			() => parseAcceptRequest(accept({ language_id: 1 })),
			/language_id must be a string/,
		);
	});

	it('rejects an object language_id', () => {
		assert.throws(
			() => parseAcceptRequest(accept({ language_id: {} })),
			/language_id must be a string/,
		);
	});

	it('passes a well-formed language_id through', () => {
		assert.equal(parseAcceptRequest(accept({ language_id: 'typescript' })).language_id, 'typescript');
	});
});

describe('parseAcceptRequest: content and hygiene', () => {
	it('preserves unicode and emoji in completion', () => {
		const text = 'return "🔥変数";';
		assert.equal(parseAcceptRequest(accept({ completion: text })).completion, text);
	});

	it('preserves a SQL-injection-looking completion', () => {
		const text = "'; DROP TABLE users; --";
		assert.equal(parseAcceptRequest(accept({ completion: text })).completion, text);
	});

	it('preserves an HTML script tag in completion', () => {
		const text = '<script>alert("xss")</script>';
		assert.equal(parseAcceptRequest(accept({ completion: text })).completion, text);
	});

	it('preserves a NUL character in completion', () => {
		assert.equal(parseAcceptRequest(accept({ completion: 'a\u0000b' })).completion, 'a\u0000b');
	});

	it('does not pollute Object.prototype via a __proto__ key', () => {
		const body = JSON.parse(
			'{"prefix":"p","completion":"c","__proto__":{"tainted":"yes"}}',
		) as unknown;
		parseAcceptRequest(body);
		assert.equal((Object.prototype as unknown as Record<string, unknown>).tainted, undefined);
	});

	it('ignores unknown fields rather than echoing or rejecting them', () => {
		const parsed = parseAcceptRequest(accept({ session_id: 's', extra: 1 }));
		assert.deepEqual(Object.keys(parsed).sort(), ['completion', 'language_id', 'prefix']);
	});
});

describe('validation errors', () => {
	it('throws InvalidRequestError, not a bare Error', () => {
		// engine/http.ts distinguishes this class to answer 400 rather than 500;
		// a plain Error here would read as a server fault.
		assert.throws(
			() => parseCompleteRequest({ prefix: 'p' }),
			(err: unknown) => err instanceof InvalidRequestError && err.name === 'InvalidRequestError',
		);
	});

	it('throws InvalidRequestError from the accept parser too', () => {
		assert.throws(
			() => parseAcceptRequest({ prefix: 'p' }),
			(err: unknown) => err instanceof InvalidRequestError && err.name === 'InvalidRequestError',
		);
	});

	it('names the offending field in the message', () => {
		// The message is the only machine-readable signal a client gets back, so a
		// generic "invalid request" would make a contract mismatch undebuggable.
		assert.throws(() => parseCompleteRequest({ prefix: 'p' }), /session_id/);
		assert.throws(() => parseCompleteRequest(complete({ suffix: 1 })), /suffix/);
		assert.throws(() => parseCompleteRequest(complete({ open_paths: 1 })), /open_paths/);
		assert.throws(() => parseAcceptRequest({ prefix: 'p' }), /completion/);
	});

	it('does not name an unrelated field', () => {
		// Guards against a copy-paste in the field literals: every check passes its
		// own name, so reporting 'prefix' for a bad suffix would misdirect a client.
		assert.throws(
			() => parseCompleteRequest(complete({ language_id: 1 })),
			(err: unknown) =>
				err instanceof InvalidRequestError &&
				err.message.includes('language_id') &&
				!err.message.includes('session_id'),
		);
	});
});
