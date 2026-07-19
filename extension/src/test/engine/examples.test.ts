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
});
