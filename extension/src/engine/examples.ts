/**
 * Accepted-completion store with lexical retrieval.
 *
 * The Python version scored a resident float32 matrix of bge-small embeddings
 * with one numpy matmul. That is gone: `fastembed` has no JS equivalent that does
 * not drag in per-platform native binaries, which is the packaging pain this
 * whole migration exists to escape. See docs/typescript-migration.md §1.4.
 *
 * What replaces it is the identifier-token overlap the ring buffer already used.
 * The threshold moves with it -- `examplesMinSimilarity` is on the Jaccard scale
 * now, not cosine; see its comment in config.ts for the measured basis of 0.15.
 *
 * Lexical does better here than "lexical vs semantic" suggests, because code
 * carries its meaning in identifiers. Asked to match each TypeScript module in
 * this repo to the Python module it was ported from -- restructured, resyntaxed,
 * renamed -- token overlap picked the right counterpart 75% of the time against
 * 11% chance.
 *
 * That is a property of the *scorer*, not of what users see: `search()` filters by
 * language first, so a cross-language match can never actually be returned. It
 * carries over to the case that does fire -- same language, different file,
 * restructured code -- and it is why the threshold is not set defensively high.
 * The scorer is still weaker than embeddings on genuine paraphrase, which is what
 * the `ExampleSource` seam is for.
 *
 * Storage is append-only JSONL rather than sqlite. That also fixes a known rough
 * edge: the old `add()` re-stacked the entire table on every accept.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { similarity, tokens } from './tokens';
import type { Example, ExampleSource } from './types';

/** Only the text right at the cursor carries retrieval signal. */
const QUERY_TAIL_CHARS = 512;

interface Row extends Example {
	tokens: Set<string>;
}

interface StoredExample {
	prefix: string;
	completion: string;
	languageId: string;
	createdAt: number;
}

export interface ExampleStoreOptions {
	filePath: string;
	topK: number;
	minSimilarity: number;
	maxRows: number;
	log?: (message: string) => void;
}

export class ExampleStore implements ExampleSource {
	private rows: Row[] = [];
	/**
	 * Lines physically in the file, which exceeds `rows.length` between
	 * compactions. Appending is O(1); rewriting is the thing we do rarely.
	 */
	private linesOnDisk = 0;
	private readonly log: (message: string) => void;
	/** Serializes appends and compaction so a rewrite cannot interleave. */
	private tail: Promise<void> = Promise.resolve();

	constructor(private readonly opts: ExampleStoreOptions) {
		this.log = opts.log ?? (() => {});
	}

	async start(): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.opts.filePath), { recursive: true });
		let raw: string;
		try {
			raw = await fs.promises.readFile(this.opts.filePath, 'utf8');
		} catch {
			// No store yet, or unreadable. Either way we start empty rather than
			// failing startup: retrieval is an enhancement.
			this.log('example store: starting empty');
			return;
		}

		const lines = raw.split('\n').filter((l) => l.trim() !== '');
		this.linesOnDisk = lines.length;
		const parsed: Row[] = [];
		let skipped = 0;
		for (const line of lines) {
			const row = this.parse(line);
			if (row === null) {
				skipped++;
				continue;
			}
			parsed.push(row);
		}
		// Oldest first in the file, so the newest survive the cap.
		this.rows = parsed.slice(-this.opts.maxRows);
		this.log(
			`example store ready: ${this.rows.length} examples` +
				(skipped > 0 ? ` (${skipped} unreadable lines skipped)` : ''),
		);
		if (this.linesOnDisk > this.rows.length) {
			await this.compact();
		}
	}

	private parse(line: string): Row | null {
		try {
			const obj = JSON.parse(line) as Partial<StoredExample>;
			if (typeof obj.prefix !== 'string' || typeof obj.completion !== 'string') {
				return null;
			}
			return {
				prefix: obj.prefix,
				completion: obj.completion,
				languageId: typeof obj.languageId === 'string' ? obj.languageId : '',
				tokens: tokens(obj.prefix),
			};
		} catch {
			return null;
		}
	}

	async add(args: { prefix: string; completion: string; languageId: string }): Promise<void> {
		if (!args.completion.trim()) {
			return;
		}
		const prefix = args.prefix.slice(-QUERY_TAIL_CHARS);
		const row: Row = {
			prefix,
			completion: args.completion,
			languageId: args.languageId,
			tokens: tokens(prefix),
		};
		this.rows.push(row);
		if (this.rows.length > this.opts.maxRows) {
			this.rows.shift();
		}

		const line = `${JSON.stringify({
			prefix,
			completion: args.completion,
			languageId: args.languageId,
			createdAt: Date.now(),
		} satisfies StoredExample)}\n`;

		this.tail = this.tail
			.then(async () => {
				await fs.promises.appendFile(this.opts.filePath, line, 'utf8');
				this.linesOnDisk++;
				// Amortised: rewriting on every accept is exactly the O(n)-per-accept
				// cost this storage format was chosen to avoid.
				if (this.linesOnDisk > this.opts.maxRows * 1.5) {
					await this.rewrite();
				}
			})
			.catch((err: unknown) => {
				this.log(`example store: write failed: ${String(err)}`);
			});
		await this.tail;
	}

	async search(args: { prefix: string; languageId: string }): Promise<Example[]> {
		if (this.rows.length === 0) {
			return [];
		}
		const query = tokens(args.prefix.slice(-QUERY_TAIL_CHARS));
		if (query.size === 0) {
			return [];
		}

		const scored: Array<{ score: number; row: Row }> = [];
		for (const row of this.rows) {
			// Language filtering happens before top-k, not after. The Python version
			// sliced to top_k first and then dropped mismatches, so one high-scoring
			// example in the wrong language silently cost a slot instead of letting
			// the next-best in.
			if (args.languageId && row.languageId && row.languageId !== args.languageId) {
				continue;
			}
			const score = similarity(query, row.tokens);
			if (score >= this.opts.minSimilarity) {
				scored.push({ score, row });
			}
		}
		scored.sort((a, b) => b.score - a.score);
		return scored
			.slice(0, this.opts.topK)
			.map(({ row }) => ({
				prefix: row.prefix,
				completion: row.completion,
				languageId: row.languageId,
			}));
	}

	count(): number {
		return this.rows.length;
	}

	/** Flush any queued write. Called on shutdown. */
	async close(): Promise<void> {
		await this.tail;
	}

	private async compact(): Promise<void> {
		this.tail = this.tail.then(() => this.rewrite()).catch(() => {});
		await this.tail;
	}

	private async rewrite(): Promise<void> {
		const body = this.rows
			.map((r) =>
				JSON.stringify({
					prefix: r.prefix,
					completion: r.completion,
					languageId: r.languageId,
					createdAt: Date.now(),
				} satisfies StoredExample),
			)
			.join('\n');
		// Write-then-rename: a crash mid-compaction must not truncate the store.
		const tmp = `${this.opts.filePath}.tmp`;
		await fs.promises.writeFile(tmp, body === '' ? '' : `${body}\n`, 'utf8');
		await fs.promises.rename(tmp, this.opts.filePath);
		this.linesOnDisk = this.rows.length;
	}
}
