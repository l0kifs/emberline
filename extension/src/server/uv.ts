/**
 * Locating (or installing) uv.
 *
 * uv is how the Python server gets onto a machine that has no Python. It
 * bootstraps its own interpreter, so the user needs nothing preinstalled.
 *
 * Resolution is: whatever is already on PATH, then a private copy under the
 * extension's global storage, then download one. The private copy is deliberate
 * -- it is ~35MB extracted, touches no shell profile, adds nothing to PATH, and
 * disappears when the extension is uninstalled. Astral's install.sh would do the
 * same job, but it needs a shell and edits rc files by default; fetching the
 * release tarball is fewer moving parts and pins exactly.
 *
 * No `vscode` import: this is unit-testable without an extension host.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Pinned: a floating version would change the toolchain under a fixed extension. */
const UV_VERSION = '0.11.29';

export class UvUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UvUnavailableError';
	}
}

function assetName(): string {
	const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
	switch (process.platform) {
		case 'darwin':
			return `uv-${arch}-apple-darwin`;
		case 'linux':
			return `uv-${arch}-unknown-linux-gnu`;
		default:
			throw new UvUnavailableError(`no uv build for platform '${process.platform}'`);
	}
}

async function isRunnable(bin: string): Promise<boolean> {
	try {
		await exec(bin, ['--version'], { timeout: 10_000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * Absolute path to a usable uv, installing a private copy if needed.
 *
 * `onDownload` fires only when a download actually starts, so callers can leave
 * the progress UI silent in the common case where uv is already present.
 */
export async function resolveUv(
	storageDir: string,
	log: { info(msg: string): void },
	onDownload?: () => void,
): Promise<string> {
	// PATH first. VS Code resolves the user's login shell environment on macOS
	// and Linux, so a Homebrew or curl-installed uv is visible here -- but only
	// as of the window's startup, which is why a mid-session install needs a
	// window reload to be seen.
	if (await isRunnable('uv')) {
		log.info('uv: using the one on PATH');
		return 'uv';
	}

	const privateUv = path.join(storageDir, 'uv', 'uv');
	if (await isRunnable(privateUv)) {
		log.info(`uv: using private copy at ${privateUv}`);
		return privateUv;
	}

	onDownload?.();
	const asset = assetName();
	const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}.tar.gz`;
	log.info(`uv: downloading ${url}`);

	const dir = path.join(storageDir, 'uv');
	await fs.mkdir(dir, { recursive: true });
	const tarball = path.join(dir, `${asset}.tar.gz`);

	const res = await fetch(url, { redirect: 'follow' });
	if (!res.ok) {
		throw new UvUnavailableError(`downloading uv failed: ${res.status} ${res.statusText}`);
	}
	await fs.writeFile(tarball, Buffer.from(await res.arrayBuffer()));

	// The tarball unpacks into a single `<asset>/` directory holding uv and uvx.
	await exec('tar', ['-xzf', tarball, '-C', dir]);
	await fs.rename(path.join(dir, asset, 'uv'), privateUv);
	await fs.chmod(privateUv, 0o755);
	await fs.rm(path.join(dir, asset), { recursive: true, force: true });
	await fs.rm(tarball, { force: true });

	if (!(await isRunnable(privateUv))) {
		throw new UvUnavailableError(`downloaded uv but it will not run: ${privateUv}`);
	}
	log.info(`uv: installed private copy at ${privateUv}`);
	return privateUv;
}

/**
 * Environment that keeps everything uv does inside the extension's storage.
 *
 * Without these, `uv tool install` writes to ~/.local/{share,bin} -- shared
 * state we do not own and cannot clean up on uninstall. Verified: with both set,
 * nothing lands in ~/.local/bin.
 */
export function uvToolEnv(storageDir: string): Record<string, string> {
	return {
		UV_TOOL_DIR: path.join(storageDir, 'uv', 'tools'),
		UV_TOOL_BIN_DIR: path.join(storageDir, 'uv', 'bin'),
		UV_PYTHON_INSTALL_DIR: path.join(storageDir, 'uv', 'python'),
	};
}

export const UV_PINNED_VERSION = UV_VERSION;
