import { execFile as execFileCb } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { StorageProvider } from '@maskin/storage'

const execFile = promisify(execFileCb)

const SESSION_WORKSPACE_PREFIX = 'session-workspaces'
const LEGACY_SESSION_WORKSPACE_PREFIX = 'agent-workspaces'

export const SESSION_SKELETON_DIRS = ['workspace', 'skills', 'learnings', 'memory'] as const

// Whitelist on sessionId before it reaches an S3 key or a `tar` arg list.
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function sessionWorkspaceKey(sessionId: string): string {
	assertValidSessionId(sessionId)
	return `${SESSION_WORKSPACE_PREFIX}/${sessionId}.tar.gz`
}

function assertValidSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`)
	}
}

// Bind-mounting /agent into a microVM wipes WORKDIR, so the four subdirs the
// agent harness reads must exist on the host BEFORE boot — bet constraint #3.
async function ensureSkeleton(sessionDir: string): Promise<void> {
	for (const sub of SESSION_SKELETON_DIRS) {
		await mkdir(join(sessionDir, sub), { recursive: true })
	}
}

export type PullSessionWorkspaceResult = {
	restored: boolean
	archiveBytes: number
}

/**
 * Prepare sessionDir to be bind-mounted as `/agent` into a microVM.
 *
 * Behaviour:
 * - If a workspace snapshot exists in S3 for the source or own session, extract
 *   it into sessionDir (restoring prior session state).
 * - Key priority: session-workspaces/{sourceSessionId} → session-workspaces/{sessionId}
 *   → agent-workspaces/{sessionId} (legacy backward-compat path).
 * - If no snapshot is found, leave sessionDir empty (fresh session).
 * - In both cases, guarantee `workspace/`, `skills/`, `learnings/`, `memory/`
 *   exist before returning.
 */
export async function pullSessionWorkspace(
	storage: StorageProvider,
	sessionId: string,
	sessionDir: string,
	sourceSessionId?: string,
): Promise<PullSessionWorkspaceResult> {
	await mkdir(sessionDir, { recursive: true })

	let restored = false
	let archiveBytes = 0

	// Try keys in priority order: source session first (continuation), then own
	// session (retry), then legacy path (backward compat for old deployments).
	const candidates: string[] = [
		...(sourceSessionId ? [`${SESSION_WORKSPACE_PREFIX}/${sourceSessionId}.tar.gz`] : []),
		sessionWorkspaceKey(sessionId),
		`${LEGACY_SESSION_WORKSPACE_PREFIX}/${sessionId}.tar.gz`,
	]

	let resolvedKey: string | null = null
	for (const candidate of candidates) {
		if (await storage.exists(candidate)) {
			resolvedKey = candidate
			break
		}
	}

	if (resolvedKey) {
		const buf = await storage.get(resolvedKey)
		archiveBytes = buf.length
		const stage = await mkdtemp(join(tmpdir(), 'maskin-agent-pull-'))
		const archivePath = join(stage, 'workspace.tar.gz')
		try {
			await writeFile(archivePath, buf)
			// --strip-components=1 normalises two archive formats:
			// - agent-server snapshots: entries rooted at `.` (e.g. `./workspace/…`)
			// - Docker copyFrom snapshots: entries rooted at `agent` (e.g. `agent/workspace/…`)
			// In both cases stripping one component lands files at `sessionDir/workspace/…`.
			await execFile('tar', ['-xzf', archivePath, '-C', sessionDir, '--strip-components=1'])
			restored = true
		} finally {
			await rm(stage, { recursive: true, force: true })
		}
	}

	await ensureSkeleton(sessionDir)
	return { restored, archiveBytes }
}

/**
 * Delete the session's host-side workspace directory. Called after the workspace
 * has been pushed to S3 so the bind-mount dir doesn't accumulate on disk.
 */
export async function deleteSessionDir(sessionDir: string): Promise<void> {
	await rm(sessionDir, { recursive: true, force: true })
}

export type PushSessionWorkspaceResult = {
	archiveBytes: number
}

/**
 * Pack `sessionDir` into `session-workspaces/<sessionId>.tar.gz` and upload.
 *
 * Pairs with `pullSessionWorkspace` — `pull → run microVM → push` round-trips
 * the workspace through S3 between sessions. Last writer wins on the S3 key.
 */
export async function pushSessionWorkspace(
	storage: StorageProvider,
	sessionId: string,
	sessionDir: string,
): Promise<PushSessionWorkspaceResult> {
	const key = sessionWorkspaceKey(sessionId)
	const sessionStat = await stat(sessionDir).catch(() => null)
	if (!sessionStat?.isDirectory()) {
		throw new Error(`Cannot push session workspace — not a directory: ${sessionDir}`)
	}

	const stage = await mkdtemp(join(tmpdir(), 'maskin-agent-push-'))
	const archivePath = join(stage, 'workspace.tar.gz')
	try {
		// `-C sessionDir` + `.` packs entries relative to sessionDir with a leading
		// `.` component (e.g. `./workspace/…`). pullSessionWorkspace uses
		// --strip-components=1 which strips that `.`, landing files at newDir/*.
		await execFile('tar', ['-C', sessionDir, '-czf', archivePath, '.'])
		const buf = await readFile(archivePath)
		await storage.put(key, buf)
		return { archiveBytes: buf.length }
	} finally {
		await rm(stage, { recursive: true, force: true })
	}
}
