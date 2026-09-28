import { execFile as execFileCb } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { StorageProvider } from '@maskin/storage'

const execFile = promisify(execFileCb)

const SESSION_WORKSPACE_PREFIX = 'session-workspaces'
const LEGACY_SESSION_WORKSPACE_PREFIX = 'agent-workspaces'

export const SESSION_SKELETON_DIRS = ['workspace', 'skills', 'learnings', 'memory'] as const

// Temporary name for the snapshot archive while it is staged inside sessionDir
// for extraction. Removed in a `finally` before the caller ever sees the dir.
const PULL_ARCHIVE_NAME = '.maskin-pull.tar.gz'

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
		// The archive is staged INSIDE sessionDir and tar is run with `cwd: sessionDir`,
		// so neither the archive operand nor the extraction directory is ever passed as
		// an absolute path. GNU tar on Windows mangles both: it misreads an absolute
		// `C:\...` archive argument as a `host:path` remote spec (rsh to a host named
		// "C"), and it garbles an absolute `-C` argument into an unopenable path.
		const archivePath = join(sessionDir, PULL_ARCHIVE_NAME)
		try {
			await writeFile(archivePath, buf)
			// --strip-components=1 normalises two archive formats:
			// - agent-server snapshots: entries rooted at `.` (e.g. `./workspace/…`)
			// - Docker copyFrom snapshots: entries rooted at `agent` (e.g. `agent/workspace/…`)
			// In both cases stripping one component lands files at `sessionDir/workspace/…`.
			await execFile('tar', ['-xzf', PULL_ARCHIVE_NAME, '--strip-components=1'], {
				cwd: sessionDir,
			})
			restored = true
		} finally {
			await rm(archivePath, { force: true })
		}
	}

	await ensureSkeleton(sessionDir)
	return { restored, archiveBytes }
}

export type SessionSkillManifestEntry = {
	name: string
	files: { relativePath: string; storageKey: string }[]
}

export type StageSessionSkillsResult = {
	staged: number
	failures: { name: string; error: string }[]
}

// Whitelist the same characters the SESSION_REQUEST_SCHEMA in ../index.ts
// already enforces. Duplicated here so this function is safe to call even
// from a caller that bypassed the schema (e.g. a future direct in-process
// invocation) — path-traversal defence must not depend on validation
// having happened upstream.
const STAGE_SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const STAGE_SKILL_RELATIVE_PATH_RE =
	/^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9._][A-Za-z0-9._/-]*$/

/**
 * Materialise the workspace-skill manifest at `<sessionDir>/skills/<name>/<relativePath>`.
 *
 * Called by `POST /sessions` **after** `pullSessionWorkspace()` (which restores
 * the S3 snapshot and creates the four skeleton dirs, `skills/` included)
 * and **before** `spawnSession()` mounts `sessionDir` as `/agent` inside the
 * guest. That ordering matters — the mount only reaches the guest on entry,
 * so anything written after `spawnSession` lands host-side and never enters
 * the VM (see `buildMsbCreateArgs` in `microsandbox.ts`, which mounts
 * exactly one path: `${sessionDir}:/agent`).
 *
 * Idempotent, all-or-nothing per skill:
 * - Fetches every file for a skill into memory before touching disk, so a
 *   partial S3 failure never leaves a half-written `<name>/` folder that
 *   `folderExists()` would later mistake for a complete skill.
 * - Overwrites unconditionally (`overwrite: true` semantics from `agent-storage.ts`).
 *   `ensureSkeleton` created an empty `skills/` on a fresh session, and a
 *   resumed session's snapshot may carry stale copies; either way the
 *   dispatch manifest is the source of truth for what an agent boots with.
 *
 * Failure mode is **degraded-start, loud**: a per-skill fetch or write
 * failure is recorded in `failures` and the caller (`POST /sessions`) reports
 * it back to apps/dev so `session_skill_load_failed` fires — but the session
 * still boots, so an S3 blip on one skill does not take down the whole
 * agent. Never throws.
 *
 * The empty-manifest case (agent has no attached skills, or agent-server
 * predates the field so `body.skills` defaulted to `[]`) is a no-op that
 * returns `{ staged: 0, failures: [] }` without touching the disk beyond
 * the skeleton `ensureSkeleton` already created.
 */
export async function stageSessionSkills(
	storage: StorageProvider,
	sessionDir: string,
	manifest: readonly SessionSkillManifestEntry[],
): Promise<StageSessionSkillsResult> {
	if (manifest.length === 0) return { staged: 0, failures: [] }

	const skillsRoot = join(sessionDir, 'skills')
	await mkdir(skillsRoot, { recursive: true })

	let staged = 0
	const failures: { name: string; error: string }[] = []

	for (const entry of manifest) {
		if (!STAGE_SKILL_NAME_RE.test(entry.name)) {
			failures.push({ name: entry.name, error: 'invalid_skill_name' })
			continue
		}
		if (entry.files.length === 0) {
			failures.push({ name: entry.name, error: 'empty_manifest_entry' })
			continue
		}

		try {
			// Fetch every file BEFORE touching disk — same all-or-nothing rule
			// pullWorkspaceSkillsForAgent uses: a mid-fetch S3 failure must not
			// leave a partial folder that reads as a complete skill on the
			// next boot / resume.
			const files: { relativePath: string; data: Buffer }[] = []
			for (const { relativePath, storageKey } of entry.files) {
				if (!STAGE_SKILL_RELATIVE_PATH_RE.test(relativePath)) {
					throw new Error(`invalid_relative_path: ${relativePath}`)
				}
				const data = await storage.get(storageKey)
				files.push({ relativePath, data })
			}

			const skillFolder = join(skillsRoot, entry.name)
			// Overwrite semantics: a resumed session's snapshot may have staged
			// a stale copy of this skill under the same name; the dispatch
			// manifest is the source of truth.
			await rm(skillFolder, { recursive: true, force: true })
			try {
				for (const { relativePath, data } of files) {
					const destPath = join(skillFolder, relativePath)
					await mkdir(dirname(destPath), { recursive: true })
					await writeFile(destPath, data)
				}
			} catch (err) {
				// A partial folder would satisfy folderExists() and read as a
				// complete workspace skill on the next boot — remove it before
				// reporting the failure.
				await rm(skillFolder, { recursive: true, force: true }).catch(() => {})
				throw err
			}
			staged++
		} catch (err) {
			failures.push({ name: entry.name, error: String(err) })
		}
	}

	return { staged, failures }
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

export type PushSessionWorkspaceOptions = {
	retries?: number
	retryDelayMs?: number
	sleep?: (ms: number) => Promise<void>
}

// 5 attempts with exponential backoff (2s, 4s, 8s, 16s — ~30s total) rather
// than the previous 3 attempts with linear delay (2s, 4s — ~6s). SeaweedFS
// answers `ServiceUnavailable` for tens of seconds while a volume server is
// rebalancing or restarting, which outlasted the old budget and forced an
// otherwise-successful agent run to exit non-zero (Sentry MASKIN-AGENT-SERVER-3).
const DEFAULT_PUSH_RETRIES = 5
const DEFAULT_PUSH_RETRY_DELAY_MS = 2_000
const MAX_PUSH_RETRY_DELAY_MS = 16_000

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pack `sessionDir` into `session-workspaces/<sessionId>.tar.gz` and upload.
 *
 * Pairs with `pullSessionWorkspace` — `pull → run microVM → push` round-trips
 * the workspace through S3 between sessions. Last writer wins on the S3 key.
 *
 * The upload is retried with backoff — S3-compatible backends return
 * transient throttling errors (e.g. `SlowDown`) under load, and the caller
 * (monitorSession in apps/agent-server/src/index.ts) treats ANY push failure
 * as a lost workspace and forces the session's exit code non-zero, so a
 * single throttled attempt would otherwise mark an entirely successful agent
 * run as failed.
 */
export async function pushSessionWorkspace(
	storage: StorageProvider,
	sessionId: string,
	sessionDir: string,
	options: PushSessionWorkspaceOptions = {},
): Promise<PushSessionWorkspaceResult> {
	const key = sessionWorkspaceKey(sessionId)
	const sessionStat = await stat(sessionDir).catch(() => null)
	if (!sessionStat?.isDirectory()) {
		throw new Error(`Cannot push session workspace — not a directory: ${sessionDir}`)
	}

	const retries = options.retries ?? DEFAULT_PUSH_RETRIES
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_PUSH_RETRY_DELAY_MS
	const sleep = options.sleep ?? defaultSleep

	const stage = await mkdtemp(join(tmpdir(), 'maskin-agent-push-'))
	const archivePath = join(stage, 'workspace.tar.gz')
	try {
		// `-C sessionDir` + `.` packs entries relative to sessionDir with a leading
		// `.` component (e.g. `./workspace/…`). pullSessionWorkspace uses
		// --strip-components=1 which strips that `.`, landing files at newDir/*.
		//
		// `./tmp` is excluded: agent-run.sh points TMPDIR (and the npm/pnpm/yarn
		// caches) at /agent/tmp so temp files land on this virtiofs mount instead of
		// the 512 MB RAM-backed /tmp. That scratch is per-run and can be many GB —
		// snapshotting it would balloon every workspace tarball and restore a stale
		// dependency cache into the next session.
		await execFile('tar', ['-C', sessionDir, '--exclude=./tmp', '-czf', 'workspace.tar.gz', '.'], {
			cwd: stage,
		})
		const buf = await readFile(archivePath)

		let lastErr: unknown
		for (let attempt = 1; attempt <= retries; attempt++) {
			try {
				await storage.put(key, buf)
				return { archiveBytes: buf.length }
			} catch (err) {
				lastErr = err
				if (attempt < retries) {
					await sleep(Math.min(retryDelayMs * 2 ** (attempt - 1), MAX_PUSH_RETRY_DELAY_MS))
				}
			}
		}
		throw lastErr
	} finally {
		await rm(stage, { recursive: true, force: true })
	}
}
