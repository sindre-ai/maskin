import { spawnSync } from 'node:child_process'
import type { DiffFile } from '../types.js'
import { parseUnifiedDiff } from './diff.js'

const SHA_RE = /^[0-9a-f]{7,40}$/i

/**
 * Allowlist for git refs accepted by the adapter.
 *
 * The classifier is invoked from the orchestrator with refs like `origin/main`
 * and `HEAD`, not pre-resolved SHAs. We allow alphanumerics plus the small set
 * of punctuation that real refs use, and explicitly forbid two patterns that
 * git would otherwise interpret as flags or path traversals.
 */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/^~@{}]*$/

export function assertGitRef(rev: string): void {
	if (rev.startsWith('-') || rev.includes('..') || !REF_RE.test(rev)) {
		throw new Error(`Invalid git revision: ${JSON.stringify(rev)}`)
	}
}

export function assertGitSha(sha: string): void {
	if (!SHA_RE.test(sha)) {
		throw new Error(`Invalid git sha: ${JSON.stringify(sha)}`)
	}
}

export function readDiffFromGit(baseRef: string, headRef: string, cwd: string): DiffFile[] {
	assertGitRef(baseRef)
	assertGitRef(headRef)
	const result = spawnSync(
		'git',
		['diff', '--no-color', '--no-ext-diff', '-M', `${baseRef}...${headRef}`],
		{ cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 },
	)
	if (result.status !== 0) {
		throw new Error(`git diff failed (exit ${result.status}): ${result.stderr}`)
	}
	return parseUnifiedDiff(result.stdout)
}

export function resolveCommitSha(rev: string, cwd: string): string {
	assertGitRef(rev)
	const result = spawnSync('git', ['rev-parse', '--verify', rev], { cwd, encoding: 'utf8' })
	if (result.status !== 0) {
		throw new Error(`git rev-parse failed (exit ${result.status}): ${result.stderr}`)
	}
	const sha = result.stdout.trim()
	assertGitSha(sha)
	return sha
}
