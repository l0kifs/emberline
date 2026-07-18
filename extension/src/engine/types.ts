/**
 * Shared shapes inside the engine.
 *
 * Separate from `wire.ts`: that file is the extension <-> server contract, this
 * one is the server <-> llama.cpp contract plus the interfaces that let modules
 * depend on each other by shape rather than by import.
 */

/**
 * One entry of llama.cpp's `input_extra`, which it inserts ahead of the FIM
 * prefix. Two unrelated features share this delivery slot: cross-file ring
 * chunks and previously accepted completions.
 */
export interface ExtraChunk {
	filename: string;
	text: string;
}

export interface InfillRequest {
	prefix: string;
	suffix: string;
	extra: ExtraChunk[];
	n_predict: number;
	t_max_predict_ms: number;
	temperature: number;
	top_p: number;
	top_k: number;
}

export interface InfillResult {
	content: string;
	stopType: string | null;
	superseded: boolean;
	timings: Record<string, number>;
}

export interface Example {
	prefix: string;
	completion: string;
	languageId: string;
}

/**
 * What the assembler needs from the example store.
 *
 * Narrow on purpose: the current implementation ranks lexically, but swapping in
 * an embedding-backed one (onnxruntime-web) must not touch the assembler. See
 * docs/typescript-migration.md §1.4.
 */
export interface ExampleSource {
	search(args: { prefix: string; languageId: string }): Promise<Example[]>;
}
