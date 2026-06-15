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

const WARM_POOL_TMP_PREFIX = 'maskin-warm-pool-'
const WARM_CREATE_TIMEOUT_MS = 120_000
const DEFAULT_WARM_MEMORY_MIB = 1024
const DEFAULT_WARM_CPUS = 1

type SlotState = 'warming' | 'ready' | 'claimed' | 'failed' | 'shutdown'

type Slot = {
	index: number
	name: string
	sessionDir: string
	state: SlotState
}

export type WarmPoolDeps = {
	image: string
	size: number
	hostPort: number
	msb: MicrosandboxDeps
	memoryMib?: number
	cpus?: number
	// Injectable for deterministic tests. Returns a short random suffix used in
	// warm sandbox names.
	randomSuffix?: () => string
}

function defaultSuffix(): string {
	return randomBytes(4).toString('hex')
}

export type WarmPoolClaim = { hit: boolean }

export class WarmPool {
	private slots: Slot[] = []
	private stopped = false

	constructor(private readonly deps: WarmPoolDeps) {}

	get image(): string {
		return this.deps.image
	}

	get size(): number {
		return this.deps.size
	}

	readyCount(): number {
		return this.slots.filter((s) => s.state === 'ready').length
	}

	async start(): Promise<void> {
		if (this.deps.size <= 0) return
		for (let i = 0; i < this.deps.size; i += 1) {
			const slot = await this.allocateSlot(i)
			this.slots.push(slot)
		}
		// Warm in parallel — each `msb create` is independent and the libkrun
		// image cache is the bottleneck, not concurrency on the host CPU.
		await Promise.all(this.slots.map((slot) => this.warm(slot)))
		logger.info('warm pool started', {
			image: this.deps.image,
			size: this.deps.size,
			ready: this.readyCount(),
		})
	}

	// Returns synchronously — the cold path remains the fallback so we never
	// block the POST /sessions handler on a warm-pool race.
	claim(image: string): WarmPoolClaim {
		if (this.stopped) return { hit: false }
		if (image !== this.deps.image) return { hit: false }
		const ready = this.slots.find((s) => s.state === 'ready')
		if (!ready) return { hit: false }
		ready.state = 'claimed'
		logger.info('warm pool hit', {
			image,
			slot: ready.index,
			ready: this.readyCount(),
		})
		void this.replace(ready).catch((err) => {
			logger.error('warm pool replace failed', {
				slot: ready.index,
				error: String(err),
			})
		})
		return { hit: true }
	}

	async shutdown(): Promise<void> {
		this.stopped = true
		await Promise.all(
			this.slots.map(async (slot) => {
				if (slot.state === 'ready' || slot.state === 'warming') {
					try {
						await removeSandbox(slot.name, this.deps.msb)
					} catch (err) {
						logger.warn('warm pool shutdown cleanup failed', {
							slot: slot.index,
							error: String(err),
						})
					}
				}
				slot.state = 'shutdown'
				await rm(slot.sessionDir, { recursive: true, force: true }).catch(() => {})
			}),
		)
		logger.info('warm pool stopped', { image: this.deps.image })
	}

	private async allocateSlot(index: number): Promise<Slot> {
		const suffix = (this.deps.randomSuffix ?? defaultSuffix)()
		const name = `warm-pool-${index}-${suffix}`
		const sessionDir = await mkdtemp(join(tmpdir(), WARM_POOL_TMP_PREFIX))
		// Pre-create the four agent-harness subdirs so the warm VM's mount
		// matches what a real session sees. Constraint #3 on the bet.
		await ensureSessionSkeleton(sessionDir)
		return { index, name, sessionDir, state: 'warming' }
	}

	private async warm(slot: Slot): Promise<void> {
		if (this.stopped) return
		const args = buildMsbCreateArgs({
			sessionId: slot.name,
			image: this.deps.image,
			memoryMib: this.deps.memoryMib ?? DEFAULT_WARM_MEMORY_MIB,
			cpus: this.deps.cpus ?? DEFAULT_WARM_CPUS,
			hostPort: this.deps.hostPort,
			env: {},
			sessionDir: slot.sessionDir,
			pullPolicy: 'always',
		})
		const run = this.deps.msb.run ?? defaultRunner()
		try {
			await run(this.deps.msb.msbBin, args, { timeoutMs: WARM_CREATE_TIMEOUT_MS })
			if (this.stopped) {
				await removeSandbox(slot.name, this.deps.msb).catch(() => {})
				slot.state = 'shutdown'
				return
			}
			slot.state = 'ready'
			logger.info('warm pool slot ready', {
				slot: slot.index,
				name: slot.name,
				image: this.deps.image,
			})
		} catch (err) {
			const message = String(err)
			logger.error('warm pool create failed', {
				slot: slot.index,
				name: slot.name,
				error: message,
			})
			slot.state = 'failed'
			// Best-effort: a partially-created sandbox blocks re-use of the name.
			await removeSandbox(slot.name, this.deps.msb).catch(() => {})
		}
	}

	private async replace(claimed: Slot): Promise<void> {
		if (this.stopped) return
		try {
			await removeSandbox(claimed.name, this.deps.msb)
		} catch (err) {
			logger.warn('warm pool failed to remove claimed slot', {
				slot: claimed.index,
				error: String(err),
			})
		}
		await rm(claimed.sessionDir, { recursive: true, force: true }).catch(() => {})
		if (this.stopped) return
		const replacement = await this.allocateSlot(claimed.index)
		claimed.name = replacement.name
		claimed.sessionDir = replacement.sessionDir
		claimed.state = 'warming'
		await this.warm(claimed)
	}
}
