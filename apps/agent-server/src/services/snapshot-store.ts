import { execFile as execFileCb } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

function assertValidSessionId(sessionId: string): void {
	if (!SESSION_ID_RE.test(sessionId)) {
		throw new Error(`Invalid session id: ${JSON.stringify(sessionId)}`)
	}
}

function assertValidSnapshotId(snapshotId: string): void {
	if (!SNAPSHOT_ID_RE.test(snapshotId)) {
		throw new Error(`Invalid snapshot id: ${JSON.stringify(snapshotId)}`)
	}
}

export type SnapshotRecord = {
	sessionId: string
	snapshotId: string
	path: string
	archiveBytes: number
	createdAt: string
}

// Disk-only snapshot store. Each session gets a directory under `<root>`;
// each snapshot is a single `<snapshotId>.tar.gz` file. S3 backup of these
// files is explicitly out of scope for the bet's v1 (the durable per-session
// `/agent` round-trip is T8's separate S3 surface).
//
// Layout:
//   <root>/<sessionId>/<snapshotId>.tar.gz
export class SnapshotStore {
	private readonly root: string

	constructor(root: string) {
		this.root = root
	}

	private sessionDir(sessionId: string): string {
		assertValidSessionId(sessionId)
		return join(this.root, sessionId)
	}

	private snapshotPath(sessionId: string, snapshotId: string): string {
		assertValidSnapshotId(snapshotId)
		return join(this.sessionDir(sessionId), `${snapshotId}.tar.gz`)
	}

	// Pack `sourceDir` into a new snapshot tarball. `sourceDir` is the
	// `/agent` bind-mount host path — its contents land at the archive root
	// (no `--strip-components` dance needed on extract).
	async createSnapshot(
		sessionId: string,
		snapshotId: string,
		sourceDir: string,
	): Promise<SnapshotRecord> {
		assertValidSessionId(sessionId)
		assertValidSnapshotId(snapshotId)

		const sourceStat = await stat(sourceDir).catch(() => null)
		if (!sourceStat?.isDirectory()) {
			throw new Error(`Cannot snapshot — not a directory: ${sourceDir}`)
		}

		const dir = this.sessionDir(sessionId)
		await mkdir(dir, { recursive: true })
		const path = this.snapshotPath(sessionId, snapshotId)

		// `-C sourceDir .` packs entries relative to sourceDir so a later
		// extract with `-C destDir` lands them at destDir/*. Mirrors the
		// tar invocation in `session-workspace.ts` (T8).
		await execFile('tar', ['-C', sourceDir, '-czf', path, '.'])
		const archive = await stat(path)
		return {
			sessionId,
			snapshotId,
			path,
			archiveBytes: archive.size,
			createdAt: new Date().toISOString(),
		}
	}

	async listSnapshots(sessionId: string): Promise<SnapshotRecord[]> {
		const dir = this.sessionDir(sessionId)
		const entries = await readdir(dir).catch((err: NodeJS.ErrnoException) => {
			if (err.code === 'ENOENT') return [] as string[]
			throw err
		})
		const out: SnapshotRecord[] = []
		for (const entry of entries) {
			if (!entry.endsWith('.tar.gz')) continue
			const snapshotId = entry.slice(0, -'.tar.gz'.length)
			if (!SNAPSHOT_ID_RE.test(snapshotId)) continue
			const path = join(dir, entry)
			const archive = await stat(path)
			out.push({
				sessionId,
				snapshotId,
				path,
				archiveBytes: archive.size,
				createdAt: archive.mtime.toISOString(),
			})
		}
		out.sort((a, b) => a.snapshotId.localeCompare(b.snapshotId))
		return out
	}

	async getLatestSnapshot(sessionId: string): Promise<SnapshotRecord | null> {
		const list = await this.listSnapshots(sessionId)
		return list.length === 0 ? null : (list[list.length - 1] ?? null)
	}

	// Restore a snapshot's contents into `destDir`. Wipes `destDir` first so
	// the restored tree exactly matches the snapshot — no stale files survive.
	async restoreSnapshot(
		sessionId: string,
		snapshotId: string,
		destDir: string,
	): Promise<SnapshotRecord> {
		const path = this.snapshotPath(sessionId, snapshotId)
		const archive = await stat(path).catch(() => null)
		if (!archive?.isFile()) {
			throw new Error(`Snapshot not found: ${sessionId}/${snapshotId}`)
		}

		await rm(destDir, { recursive: true, force: true })
		await mkdir(destDir, { recursive: true })
		await execFile('tar', ['-xzf', path, '-C', destDir])
		return {
			sessionId,
			snapshotId,
			path,
			archiveBytes: archive.size,
			createdAt: archive.mtime.toISOString(),
		}
	}
}

// Mint a fresh snapshot id from the current time. Sortable lexicographically,
// safe across our SNAPSHOT_ID_RE validator, and human-readable in `ls`.
export function mintSnapshotId(now: Date = new Date()): string {
	const iso = now.toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
	return `snap-${iso}`
}
