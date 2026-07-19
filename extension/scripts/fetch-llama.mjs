#!/usr/bin/env node
/**
 * Stages llama.cpp's `llama-server` into `bin/llama/` so it can ship inside a
 * platform-specific VSIX.
 *
 * Only runs for targeted builds. The untargeted fallback VSIX ships no binary
 * and asks the user to install llama.cpp themselves, so skipping this script is
 * a supported outcome, not a failure.
 *
 * Two decisions worth knowing:
 *
 * - We ship the transitive `otool -L` closure of `llama-server`, not the whole
 *   archive. The archive carries dylibs for 38 other tools (llama-cli,
 *   llama-bench, …) we never invoke; bundling them is dead weight in a
 *   Marketplace download.
 * - We *flatten* it. The archive resolves `libggml.dylib` -> `libggml.0.dylib`
 *   -> `libggml.0.16.0.dylib` through symlinks, but a VSIX is a zip and zip
 *   cannot store symlinks -- vsce materializes each alias as a full copy, so a
 *   naive "copy the tree" ships every dylib three times (measured: 23MB on disk
 *   became 50MB in the VSIX). Instead we write exactly the names the loader asks
 *   for (`libggml.0.dylib`), each as one real file. Roughly 2.5x smaller.
 *
 * The archive is relocatable as-is: `llama-server`'s only LC_RPATH is
 * `@loader_path`, so the closure simply has to sit beside it. Nothing needs
 * install_name_tool.
 *
 * Integrity is TLS + GitHub releases, with a pinned build and a recorded digest
 * (see bin/llama/PROVENANCE.json). That is the same trust anchor clangd's
 * downloader uses; there are no published checksums for these assets.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned deliberately. A floating "latest" would make two builds of the same
// extension version ship different engines.
const LLAMA_BUILD = 'b10061';

const TARGETS = {
	'darwin-arm64': { asset: `llama-${LLAMA_BUILD}-bin-macos-arm64.tar.gz`, exe: 'llama-server' },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'bin', 'llama');

function log(msg) {
	process.stdout.write(`[fetch-llama] ${msg}\n`);
}

async function download(url, dest) {
	log(`downloading ${url}`);
	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new Error(`${url} -> ${res.status} ${res.statusText}`);
	}
	const buf = Buffer.from(await res.arrayBuffer());
	fs.writeFileSync(dest, buf);
	return createHash('sha256').update(buf).digest('hex');
}

async function main() {
	const target = process.argv[2];
	if (!target) {
		throw new Error(`usage: fetch-llama.mjs <target>   (one of: ${Object.keys(TARGETS).join(', ')})`);
	}
	const spec = TARGETS[target];
	if (!spec) {
		// Not an error: this is how the untargeted fallback VSIX is produced.
		log(`no bundled llama.cpp for target '${target}'; skipping (fallback VSIX ships no binary)`);
		return;
	}

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emberline-llama-'));
	const tarball = path.join(tmp, spec.asset);
	const url = `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/${spec.asset}`;
	const sha256 = await download(url, tarball);
	log(`sha256 ${sha256}`);

	execFileSync('tar', ['-xzf', tarball, '-C', tmp]);
	// The archive unpacks into a single `llama-<build>` directory.
	const unpacked = fs
		.readdirSync(tmp, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => path.join(tmp, e.name))[0];
	if (!unpacked) {
		throw new Error('archive did not contain a directory');
	}

	fs.rmSync(outDir, { recursive: true, force: true });
	fs.mkdirSync(outDir, { recursive: true });

	// Transitive @rpath closure, flattened: BFS over `otool -L`, materializing
	// each requested name (e.g. libggml.0.dylib) as one real file.
	const rpathDeps = (file) =>
		execFileSync('otool', ['-L', file], { encoding: 'utf8' })
			.split('\n')
			.map((l) => l.match(/^\s+@rpath\/(\S+)/)?.[1])
			.filter((n) => n && n !== path.basename(file));

	const queue = [spec.exe];
	const seen = new Set();
	while (queue.length) {
		const name = queue.shift();
		if (seen.has(name)) {
			continue;
		}
		seen.add(name);
		// realpathSync resolves the symlink chain to the real versioned file, whose
		// bytes we write under the exact name the loader requested.
		const real = fs.realpathSync(path.join(unpacked, name));
		fs.copyFileSync(real, path.join(outDir, name));
		queue.push(...rpathDeps(real));
	}
	const copied = seen.size;
	fs.copyFileSync(path.join(unpacked, 'LICENSE'), path.join(outDir, 'LICENSE'));
	fs.chmodSync(path.join(outDir, spec.exe), 0o755);

	fs.writeFileSync(
		path.join(outDir, 'PROVENANCE.json'),
		JSON.stringify({ build: LLAMA_BUILD, target, asset: spec.asset, url, sha256 }, null, 2) + '\n',
	);

	log(`staged ${copied} files into bin/llama`);

	// Prove the staged copy actually runs before it goes anywhere near a VSIX:
	// catches a missing dylib or a stripped signature now rather than on a user's
	// machine. Only possible when the host can execute the target, so a future
	// cross-build skips it rather than failing.
	const [tOs, tArch] = target.split('-');
	if (process.platform !== tOs || process.arch !== tArch) {
		log(`host is ${process.platform}-${process.arch}; cannot run ${target} — skipping verification`);
		return;
	}
	// llama-server prints its banner on stderr, so check both streams: asserting
	// on stdout alone passes vacuously and verifies nothing.
	const run = spawnSync(path.join(outDir, spec.exe), ['--version'], { encoding: 'utf8' });
	if (run.error) {
		throw new Error(`staged binary failed to execute: ${run.error.message}`);
	}
	if (run.status !== 0) {
		throw new Error(`staged binary exited ${run.status}: ${(run.stderr || '').trim()}`);
	}
	const line = `${run.stderr || ''}${run.stdout || ''}`.trim().split('\n')[0];
	if (!/^version: /.test(line)) {
		throw new Error(`staged binary ran but reported an unexpected banner: ${line || '(empty)'}`);
	}
	log(`verified: ${line}`);

	fs.rmSync(tmp, { recursive: true, force: true });
}

main().catch((err) => {
	process.stderr.write(`[fetch-llama] ${err.message}\n`);
	process.exit(1);
});
