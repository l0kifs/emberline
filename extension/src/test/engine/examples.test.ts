/**
 * The accepted-example store.
 *
 * Untested on the Python side (the I/O half was), and the port changed both the
 * ranking and the storage format, so these earn their place.
 */

import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';

import { ExampleStore, type ExampleStoreOptions } from '../../engine/examples';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-examples-'));
let seq = 0;

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function store(over: Partial<ExampleStoreOptions> = {}) {
	const filePath = path.join(tmp, `examples-${seq++}.jsonl`);
	const s = new ExampleStore({
		filePath,
		topK: 3,
		minSimilarity: 0.15,
		maxRows: 2000,
		...over,
	});
	await s.start();
	return { s, filePath };
}

/** A store file written by hand, oldest row first, so caps can be probed at startup. */
function seedFile(rows: number): string {
	const filePath = path.join(tmp, `seeded-${seq++}.jsonl`);
	const body = Array.from({ length: rows }, (_, i) =>
		JSON.stringify({
			prefix: `alphaToken betaToken v${i}`,
			completion: `return ${i}`,
			languageId: 'python',
			createdAt: 1,
		}),
	).join('\n');
	fs.writeFileSync(filePath, `${body}\n`);
	return filePath;
}

describe('example store', () => {
	it('retrieves an example whose cursor context overlaps the query', async () => {
		const { s } = await store();
		await s.add({
			prefix: 'def compute_total(order_items):\n    ',
			completion: 'return sum(i.price for i in order_items)',
			languageId: 'python',
		});
		await s.add({
			prefix: 'class HttpRetryPolicy:\n    ',
			completion: 'def __init__(self, attempts): ...',
			languageId: 'python',
		});

		const hits = await s.search({
			prefix: 'def compute_total(order_items):\n    ',
			languageId: 'python',
		});
		assert.equal(hits.length, 1);
		assert.match(hits[0].completion, /sum\(i\.price/);
	});

	it('returns nothing when nothing clears the threshold', async () => {
		// The bug this guards: without a floor, top-k always returned k rows however
		// irrelevant, so unrelated code got injected as few-shot context.
		const { s } = await store();
		await s.add({
			prefix: 'class HttpRetryPolicy:\n    ',
			completion: 'def __init__(self): ...',
			languageId: 'python',
		});
		const hits = await s.search({
			prefix: 'SELECT customer_id FROM invoices WHERE',
			languageId: 'sql',
		});
		assert.deepEqual(hits, []);
	});

	it('honours topK', async () => {
		const { s } = await store({ topK: 2, minSimilarity: 0 });
		for (let i = 0; i < 5; i++) {
			await s.add({
				prefix: `def compute_total(order_items, variant${i}):\n    `,
				completion: `return ${i}`,
				languageId: 'python',
			});
		}
		const hits = await s.search({
			prefix: 'def compute_total(order_items, variant):\n    ',
			languageId: 'python',
		});
		assert.equal(hits.length, 2);
	});

	it('filters by language before taking topK, not after', async () => {
		// The Python version sliced to top_k first and dropped mismatches after, so a
		// high-scoring example in the wrong language silently cost a slot instead of
		// letting the next-best one in. This asks for one hit and must get the
		// python one, not an empty list.
		const { s } = await store({ topK: 1, minSimilarity: 0 });
		await s.add({
			prefix: 'def compute_total(order_items):\n    ',
			completion: 'JS VERSION',
			languageId: 'javascript',
		});
		await s.add({
			prefix: 'def compute_total(order_items):\n    ',
			completion: 'PYTHON VERSION',
			languageId: 'python',
		});
		const hits = await s.search({
			prefix: 'def compute_total(order_items):\n    ',
			languageId: 'python',
		});
		assert.equal(hits.length, 1);
		assert.equal(hits[0].completion, 'PYTHON VERSION');
	});

	it('ignores a whitespace-only completion', async () => {
		const { s } = await store();
		await s.add({ prefix: 'def f():\n    ', completion: '   \n  ', languageId: 'python' });
		assert.equal(s.count(), 0);
	});

	it('survives a restart', async () => {
		const { s, filePath } = await store();
		await s.add({
			prefix: 'def compute_total(order_items):\n    ',
			completion: 'return sum(order_items)',
			languageId: 'python',
		});
		await s.close();

		const reopened = new ExampleStore({ filePath, topK: 3, minSimilarity: 0.15, maxRows: 2000 });
		await reopened.start();
		assert.equal(reopened.count(), 1);
		const hits = await reopened.search({
			prefix: 'def compute_total(order_items):\n    ',
			languageId: 'python',
		});
		assert.equal(hits.length, 1);
	});

	it('skips corrupt lines instead of failing startup', async () => {
		// Retrieval is an enhancement; a half-written line must never stop the
		// server from serving completions.
		const { s, filePath } = await store();
		await s.add({ prefix: 'def compute_total(x):\n    ', completion: 'ok', languageId: 'py' });
		await s.close();
		fs.appendFileSync(filePath, '{"prefix": "truncated…\n');

		const reopened = new ExampleStore({ filePath, topK: 3, minSimilarity: 0.15, maxRows: 2000 });
		await reopened.start();
		assert.equal(reopened.count(), 1);
	});

	it('caps rows and keeps the newest', async () => {
		const { s } = await store({ maxRows: 3, minSimilarity: 0 });
		for (let i = 0; i < 10; i++) {
			await s.add({
				prefix: `def compute_total(order_items):\n    # ${i}\n    `,
				completion: `return ${i}`,
				languageId: 'python',
			});
		}
		assert.equal(s.count(), 3);
		const hits = await s.search({
			prefix: 'def compute_total(order_items):\n    ',
			languageId: 'python',
		});
		assert.deepEqual(
			hits.map((h) => h.completion).sort(),
			['return 7', 'return 8', 'return 9'],
		);
	});

	it('compacts the file instead of rewriting it on every accept', async () => {
		// The rough edge this fixes: the sqlite version re-stacked the whole table
		// per accept. Appending is O(1); the rewrite is amortised.
		const { s, filePath } = await store({ maxRows: 4, minSimilarity: 0 });
		for (let i = 0; i < 20; i++) {
			await s.add({
				prefix: `def compute_total(items):\n    # ${i}\n    `,
				completion: `return ${i}`,
				languageId: 'python',
			});
		}
		await s.close();
		const lines = fs
			.readFileSync(filePath, 'utf8')
			.split('\n')
			.filter((l) => l.trim() !== '');
		// Bounded by the compaction trigger (maxRows * 1.5), not by 20.
		assert.ok(lines.length <= 6, `expected a compacted file, got ${lines.length} lines`);
		assert.equal(s.count(), 4);
	});

	it('does not leave a temp file behind after compaction', async () => {
		const { s, filePath } = await store({ maxRows: 2, minSimilarity: 0 });
		for (let i = 0; i < 10; i++) {
			await s.add({ prefix: `def fn${i}(items):\n    `, completion: `${i}`, languageId: 'py' });
		}
		await s.close();
		assert.equal(fs.existsSync(`${filePath}.tmp`), false);
	});

	it('keeps no rows at all when maxRows is 0', async () => {
		// The bug this guards: start() sliced with `parsed.slice(-maxRows)`, and
		// -0 === 0, so a cap of 0 kept EVERY row instead of none -- the bound turned
		// itself off at exactly the value that asked for the tightest bound.
		const filePath = seedFile(3);
		const s = new ExampleStore({ filePath, topK: 9, minSimilarity: 0, maxRows: 0 });
		await s.start();
		assert.equal(s.count(), 0);
		await s.close();
	});

	it('does not rewrite the file when the row count is exactly maxRows', async () => {
		// Compaction is amortised: it must fire only when disk lines exceed the rows
		// we kept. At exactly the cap nothing was dropped, so nothing is owed.
		const filePath = seedFile(3);
		const before = fs.readFileSync(filePath, 'utf8');
		const s = new ExampleStore({ filePath, topK: 9, minSimilarity: 0, maxRows: 3 });
		await s.start();
		await s.close();
		assert.equal(s.count(), 3);
		assert.equal(fs.readFileSync(filePath, 'utf8'), before);
	});

	it('keeps the newest maxRows when the file holds one row too many', async () => {
		const filePath = seedFile(4);
		const s = new ExampleStore({ filePath, topK: 9, minSimilarity: 0, maxRows: 3 });
		await s.start();
		const hits = await s.search({ prefix: 'alphaToken', languageId: 'python' });
		await s.close();
		assert.equal(s.count(), 3);
		assert.deepEqual(
			hits.map((h) => h.completion).sort(),
			['return 1', 'return 2', 'return 3'],
		);
	});

	it('returns nothing when topK is 0', async () => {
		const { s } = await store({ topK: 0, minSimilarity: 0 });
		await s.add({ prefix: 'alphaToken betaToken', completion: 'A', languageId: 'python' });
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.deepEqual(hits, []);
	});

	it('returns only the highest-scoring row when topK is 1', async () => {
		const { s } = await store({ topK: 1, minSimilarity: 0 });
		await s.add({ prefix: 'zzzOne zzzTwo zzzThree', completion: 'FAR', languageId: 'python' });
		await s.add({ prefix: 'alphaToken betaToken gammaToken', completion: 'NEAR', languageId: 'python' });
		const hits = await s.search({ prefix: 'alphaToken betaToken gammaToken', languageId: 'python' });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].completion, 'NEAR');
	});

	it('returns every match when topK exceeds the number of matches', async () => {
		const { s } = await store({ topK: 10, minSimilarity: 0 });
		await s.add({ prefix: 'alphaToken betaToken', completion: 'A', languageId: 'python' });
		await s.add({ prefix: 'gammaToken deltaToken', completion: 'B', languageId: 'python' });
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.equal(hits.length, 2);
	});

	it('includes a row scoring exactly the threshold', async () => {
		// The filter is `>=`, and the boundary is where an off-by-one flips a hit into
		// a miss. Jaccard of {alpha,beta,gamma} against {alpha,beta,delta} is
		// 2/(3+3-2) = 0.5 exactly -- representable, so this is not a float-fuzz test.
		const { s } = await store({ topK: 9, minSimilarity: 0.5 });
		await s.add({
			prefix: 'alphaToken betaToken deltaToken',
			completion: 'ON THE LINE',
			languageId: 'python',
		});
		await s.add({
			prefix: 'alphaToken deltaToken epsilonToken',
			completion: 'BELOW THE LINE',
			languageId: 'python',
		});
		const hits = await s.search({
			prefix: 'alphaToken betaToken gammaToken',
			languageId: 'python',
		});
		assert.deepEqual(
			hits.map((h) => h.completion),
			['ON THE LINE'],
		);
	});

	it('admits rows with zero overlap when minSimilarity is 0', async () => {
		// `>= 0` is true of a score of 0, so a floor of 0 is genuinely no floor: rows
		// sharing not one token still fill top-k slots.
		const { s } = await store({ topK: 9, minSimilarity: 0 });
		await s.add({ prefix: 'zzzOne zzzTwo', completion: 'NO OVERLAP', languageId: 'python' });
		await s.add({ prefix: 'alphaToken betaToken', completion: 'OVERLAP', languageId: 'python' });
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.deepEqual(
			hits.map((h) => h.completion),
			['OVERLAP', 'NO OVERLAP'],
		);
	});

	it('requires an identical token set when minSimilarity is 1', async () => {
		const { s } = await store({ topK: 9, minSimilarity: 1 });
		await s.add({ prefix: 'alphaToken betaToken', completion: 'EXACT', languageId: 'python' });
		await s.add({
			prefix: 'alphaToken betaToken gammaToken',
			completion: 'SUPERSET',
			languageId: 'python',
		});
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.deepEqual(
			hits.map((h) => h.completion),
			['EXACT'],
		);
	});

	it('ignores an empty completion', async () => {
		const { s } = await store();
		await s.add({ prefix: 'def f():\n    ', completion: '', languageId: 'python' });
		assert.equal(s.count(), 0);
	});

	it('drops a row whose prefix has no tokens', async () => {
		// A prefix with no tokens scores 0 against every query, so storing it would
		// only consume a maxRows slot and a line on disk for a row that can never be
		// retrieved. `add` now gates on the prefix token set, not just the completion.
		const { s } = await store();
		await s.add({ prefix: '', completion: 'return 1', languageId: 'python' });
		// A token-less-but-non-blank prefix (punctuation only) is dropped too -- the
		// guard is on tokens, not on `prefix.trim()`.
		await s.add({ prefix: ')', completion: 'return 2', languageId: 'python' });
		assert.equal(s.count(), 0);
	});

	it('returns nothing when the query yields no tokens', async () => {
		const { s } = await store({ minSimilarity: 0 });
		await s.add({ prefix: 'alphaToken betaToken', completion: 'A', languageId: 'python' });
		const hits = await s.search({ prefix: '  ){;', languageId: 'python' });
		assert.deepEqual(hits, []);
	});

	it('returns nothing when searching an empty store', async () => {
		const { s } = await store({ minSimilarity: 0 });
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.deepEqual(hits, []);
	});

	it('stores only the tail of a prefix longer than the query window', async () => {
		// QUERY_TAIL_CHARS = 512: only the text at the cursor carries retrieval
		// signal, so the head is dropped at write time, not just at query time.
		const { s } = await store({ minSimilarity: 0 });
		const long = `headMarker ${'x'.repeat(600)} tailMarker`;
		await s.add({ prefix: long, completion: 'T', languageId: 'python' });
		const hits = await s.search({ prefix: 'tailMarker', languageId: 'python' });
		assert.equal(hits.length, 1);
		assert.equal(hits[0].prefix.length, 512);
		assert.equal(hits[0].prefix, long.slice(-512));
		assert.equal(hits[0].prefix.includes('headMarker'), false);
	});

	it('loses no line when two adds are in flight at once', async () => {
		// The `tail` promise chain is what serialises appends. Two unawaited adds
		// racing on the same fd would otherwise interleave or drop a write.
		const { s, filePath } = await store({ maxRows: 100 });
		const first = s.add({ prefix: 'alphaToken', completion: 'A', languageId: 'python' });
		const second = s.add({ prefix: 'betaToken', completion: 'B', languageId: 'python' });
		await Promise.all([first, second]);
		await s.close();
		const lines = fs
			.readFileSync(filePath, 'utf8')
			.split('\n')
			.filter((l) => l.trim() !== '');
		assert.equal(lines.length, 2);
		assert.deepEqual(
			lines.map((l) => (JSON.parse(l) as { completion: string }).completion).sort(),
			['A', 'B'],
		);
	});

	it('searches cleanly before start has run', async () => {
		const s = new ExampleStore({
			filePath: path.join(tmp, 'never-started.jsonl'),
			topK: 3,
			minSimilarity: 0,
			maxRows: 10,
		});
		const hits = await s.search({ prefix: 'alphaToken betaToken', languageId: 'python' });
		assert.deepEqual(hits, []);
	});

	it('counts zero on a fresh store', async () => {
		const { s } = await store();
		assert.equal(s.count(), 0);
	});

	it('tolerates close being called twice', async () => {
		const { s } = await store();
		await s.add({ prefix: 'alphaToken', completion: 'A', languageId: 'python' });
		await s.close();
		await s.close();
		assert.equal(s.count(), 1);
	});

	it('starts empty when every line in the store is corrupt', async () => {
		const filePath = path.join(tmp, `all-corrupt-${seq++}.jsonl`);
		fs.writeFileSync(filePath, 'not json at all\n{oops\n[[[\n');
		const s = new ExampleStore({ filePath, topK: 3, minSimilarity: 0, maxRows: 10 });
		await s.start();
		await s.close();
		assert.equal(s.count(), 0);
	});

	it('skips a line that parses but whose prefix is not a string', async () => {
		// JSON.parse succeeding is not validation: a numeric prefix would reach
		// tokens() and throw on every keystroke rather than at startup.
		const filePath = path.join(tmp, `non-string-${seq++}.jsonl`);
		fs.writeFileSync(
			filePath,
			`${JSON.stringify({ prefix: 5, completion: 'x', languageId: 'python', createdAt: 1 })}\n`,
		);
		const s = new ExampleStore({ filePath, topK: 3, minSimilarity: 0, maxRows: 10 });
		await s.start();
		await s.close();
		assert.equal(s.count(), 0);
	});
});
