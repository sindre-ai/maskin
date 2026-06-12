import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderOverflowScript, sanitizeEnvForLibkrun } from '../lib/env-sanitizer'
import { logger } from '../lib/logger'
import type { MsbCli } from './msb-cli'
import { type SnapshotRecord, type SnapshotStore, mintSnapshotId } from './snapshot-store'

// One-to-one mapping: a session's sandbox name and `/agent` host path are
// derived from its sessionId, so stop / snapshot / restore can operate
// purely from sessionId without a separate in-memory registry.
export type SessionLifecycleConfig = {
	// Root for `/agent` bind-mounts. Each session lives at
	// `<sessionDirRoot>/<sessionId>` and is the host side of the microVM's
	// `/agent` mount. T1's HOST_SETUP §5 pre-creates the parent path.
	sessionDirRoot: string
	// Defaults for `msb create` on restore, since the bet does not (yet)
	// persist per-session memory/cpu/duration. T2 will hand these to its
	// spawn endpoint via the same path.
	defaultMemoryMib: number
	defaultCpus: number
	defaultMaxDurationSecs?: number
}

export type RestoreRequest = {
	// Image to boot. The bet does not persist the original session's image,
	// so the caller (queue / dispatcher) is responsible for re-supplying it.
	image: string
	// Fresh env. Secrets may have rotated since the original spawn — the
	// caller is responsible for supplying the env the restored session needs.
	env: Record<string, string>
	// Specific snapshot to restore. When omitted, restores the most recent
	// snapshot for the session.
	snapshotId?: string
	memoryMib?: number
	cpus?: number
	maxDurationSecs?: number
}

export type StopResult = {
	sessionId: string
	stopped: true
}

export type SnapshotResult = {
	sessionId: string
	snapshot: SnapshotRecord
}

export type RestoreResult = {
	sessionId: string
	sandboxName: string
	sessionDir: string
	snapshot: SnapshotRecord
}

export class SessionLifecycle {
	private readonly msb: MsbCli
	private readonly snapshots: SnapshotStore
	private readonly config: SessionLifecycleConfig

	constructor(msb: MsbCli, snapshots: SnapshotStore, config: SessionLifecycleConfig) {
		this.msb = msb
		this.snapshots = snapshots
		this.config = config
	}

	sessionDir(sessionId: string): string {
		return join(this.config.sessionDirRoot, sessionId)
	}

	// Gracefully halt a running sandbox by deferring to `msb remove -f`,
	// which stops + removes atomically. The host-side `/agent` bind-mount
	// dir is left intact so a subsequent snapshot captures clean state.
	async stop(sessionId: string): Promise<StopResult> {
		await this.msb.remove(sessionId)
		logger.info('session stopped', { sessionId })
		return { sessionId, stopped: true }
	}

	// Pack the session's `/agent` host path into a host-local snapshot
	// tarball. Must be called after `stop()` — the disk-only model assumes
	// the workspace is quiescent. If called against a live session, the
	// snapshot will reflect whatever made it to disk at tar time.
	async snapshot(sessionId: string): Promise<SnapshotResult> {
		const snapshotId = mintSnapshotId()
		const sourceDir = this.sessionDir(sessionId)
		const snapshot = await this.snapshots.createSnapshot(sessionId, snapshotId, sourceDir)
		logger.info('session snapshot created', {
			sessionId,
			snapshotId,
			archiveBytes: snapshot.archiveBytes,
		})
		return { sessionId, snapshot }
	}

	// Boot a fresh microVM from a snapshot, preserving sessionId. Snapshot
	// content is extracted into the session's `/agent` host path and bound
	// into the new VM, so the agent process inside resumes with the same
	// workspace it had at snapshot time.
	async restore(sessionId: string, request: RestoreRequest): Promise<RestoreResult> {
		const snapshot = request.snapshotId
			? await this.snapshots
					.listSnapshots(sessionId)
					.then((list) => list.find((s) => s.snapshotId === request.snapshotId))
			: await this.snapshots.getLatestSnapshot(sessionId)

		if (!snapshot) {
			throw new Error(
				request.snapshotId
					? `Snapshot not found: ${sessionId}/${request.snapshotId}`
					: `No snapshots found for session: ${sessionId}`,
			)
		}

		const sessionDir = this.sessionDir(sessionId)
		await this.snapshots.restoreSnapshot(sessionId, snapshot.snapshotId, sessionDir)

		const { sanitized, overflow } = sanitizeEnvForLibkrun(request.env)
		if (overflow.length > 0) {
			// Bet operational constraint #2: values >~1500 chars break the VMM
			// handshake. Spill into `/agent/.env-overflow.sh` and source it
			// from the entrypoint inside the VM. The bind-mount makes
			// sessionDir on the host visible as `/agent` inside.
			await mkdir(sessionDir, { recursive: true })
			await writeFile(join(sessionDir, '.env-overflow.sh'), renderOverflowScript(overflow), {
				mode: 0o600,
			})
			logger.info('session overflow env spilled', {
				sessionId,
				overflowKeys: overflow.map((e) => e.key),
			})
		}

		await this.msb.create({
			name: sessionId,
			image: request.image,
			memoryMib: request.memoryMib ?? this.config.defaultMemoryMib,
			cpus: request.cpus ?? this.config.defaultCpus,
			env: sanitized,
			volumes: [{ host: sessionDir, guest: '/agent' }],
			...(request.maxDurationSecs !== undefined
				? { maxDurationSecs: request.maxDurationSecs }
				: this.config.defaultMaxDurationSecs !== undefined
					? { maxDurationSecs: this.config.defaultMaxDurationSecs }
					: {}),
		})

		logger.info('session restored', {
			sessionId,
			snapshotId: snapshot.snapshotId,
			image: request.image,
		})
		return { sessionId, sandboxName: sessionId, sessionDir, snapshot }
	}
}
