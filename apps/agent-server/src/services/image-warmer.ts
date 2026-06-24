import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logger } from '../lib/logger'
import {
	type MicrosandboxDeps,
	buildMsbCreateArgs,
	defaultRunner,
	ensureSessionSkeleton,
	removeSandbox,
} from './microsandbox'

const WARM_TMP_PREFIX = 'maskin-image-warmer-'
const WARM_CREATE_TIMEOUT_MS = 120_000
const DEFAULT_WARM_MEMORY_MIB = 1024
const DEFAULT_WARM_CPUS = 1

function defaultSuffix(): string {
	return randomBytes(4).toString('hex')
}

function defaultSchedule(fn: () => void, ms: number): () => void {
	const handle = setInterval(fn, ms)
	handle.unref()
	return () => clearInterval(handle)
}

export type ImageWarmerDeps = {
	image: string
	hostPort: number
	msb: MicrosandboxDeps
	// 0 (or unset) warms the cache once at startup. A positive value re-warms on
	// that cadence so a moving `:latest` tag eventually reaches sessions without
	// a server restart.
	refreshMs?: number
	memoryMib?: number
	cpus?: number
	// Injectable for deterministic tests.
	randomSuffix?: () => string
	schedule?: (fn: () => void, ms: number) => () => void
}

/**
 * Keeps a single image present in libkrun's host-wide image cache so that
 * session spawns can use `--pull missing` and skip the network pull — the
 * dominant cost in a cold start on a fresh box.
 *
 * Unlike a pool of live VMs, nothing stays resident: each warm does one
 * `msb create --pull always` (which populates the cache) immediately followed
 * by `msb remove`. The cache is per-host and shared by every session, so a
 * single warmed image benefits all subsequent spawns — there is no value in
 * holding N idle microVMs for it.
 */
export class ImageWarmer {
	private warmed = false
	private stopped = false
	private cancelRefresh: (() => void) | null = null

	constructor(private readonly deps: ImageWarmerDeps) {}

	get image(): string {
		return this.deps.image
	}

	// True once the image has been successfully pulled into the host cache, so a
	// session for the same image can safely skip the pull. Returns false until
	// the first warm succeeds and for any other image — both fall back to the
	// self-correcting `--pull always` path.
	isWarm(image: string): boolean {
		return this.warmed && !this.stopped && image === this.deps.image
	}

	async start(): Promise<void> {
		await this.warmOnce()
		const refreshMs = this.deps.refreshMs ?? 0
		if (refreshMs > 0 && !this.stopped) {
			const schedule = this.deps.schedule ?? defaultSchedule
			this.cancelRefresh = schedule(() => void this.warmOnce(), refreshMs)
		}
	}

	async shutdown(): Promise<void> {
		this.stopped = true
		this.cancelRefresh?.()
		this.cancelRefresh = null
	}

	private async warmOnce(): Promise<void> {
		if (this.stopped) return
		const suffix = (this.deps.randomSuffix ?? defaultSuffix)()
		const name = `image-warmer-${suffix}`
		const sessionDir = await mkdtemp(join(tmpdir(), WARM_TMP_PREFIX))
		try {
			// The throwaway VM still bind-mounts /agent, so the skeleton must exist
			// or libkrun panics (bet constraint #3) — even though we discard it.
			await ensureSessionSkeleton(sessionDir)
			const args = buildMsbCreateArgs({
				sessionId: name,
				image: this.deps.image,
				memoryMib: this.deps.memoryMib ?? DEFAULT_WARM_MEMORY_MIB,
				cpus: this.deps.cpus ?? DEFAULT_WARM_CPUS,
				hostPort: this.deps.hostPort,
				env: {},
				sessionDir,
				pullPolicy: 'always',
			})
			const run = this.deps.msb.run ?? defaultRunner()
			await run(this.deps.msb.msbBin, args, { timeoutMs: WARM_CREATE_TIMEOUT_MS })
			// Tear the VM down immediately — we only wanted the pull it performed.
			await removeSandbox(name, this.deps.msb).catch((err) => {
				logger.warn('image warmer cleanup failed', { name, error: String(err) })
			})
			this.warmed = true
			logger.info('image warm complete', { image: this.deps.image })
		} catch (err) {
			// Leave `warmed` as-is: a failed refresh keeps the previously-cached
			// image usable; a failed first warm leaves us on the cold path.
			logger.error('image warm failed', { image: this.deps.image, error: String(err) })
			await removeSandbox(name, this.deps.msb).catch(() => {})
		} finally {
			await rm(sessionDir, { recursive: true, force: true }).catch(() => {})
		}
	}
}
