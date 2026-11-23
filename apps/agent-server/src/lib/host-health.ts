import { statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { StorageProvider } from '@maskin/storage'

export type HostHealth = { ok: true } | { ok: false; reason: string }

export type HostHealthOptions = {
	/** Directory session folders are written to; free space is measured on its mount. */
	sessionRoot: string
	/** Null when the server runs without file storage; the read probe is then skipped. */
	storage: StorageProvider | null
	/** Red below this share of the disk free. 0 turns the check off. */
	minFreePercent: number
	/** Red below this many bytes free. 0 turns the check off. */
	minFreeBytes: number
	storageTimeoutMs: number
}

// Key that never exists: a healthy store answers "not found", a failing one throws.
const STORAGE_PROBE_KEY = '.health-probe'

/**
 * Free space on the session directory and a small read from file storage.
 * Only a failed read or a measured shortfall is red; a disk that cannot be
 * measured at all is left out of the answer rather than reported as failing.
 */
export async function checkHostHealth(opts: HostHealthOptions): Promise<HostHealth> {
	const disk = await readDiskFree(opts.sessionRoot)
	if (disk) {
		if (opts.minFreeBytes > 0 && disk.freeBytes < opts.minFreeBytes) {
			return {
				ok: false,
				reason: `disk_low: ${disk.freeBytes} bytes free, floor ${opts.minFreeBytes}`,
			}
		}
		if (opts.minFreePercent > 0 && disk.totalBytes > 0) {
			const freePercent = (disk.freeBytes / disk.totalBytes) * 100
			if (freePercent < opts.minFreePercent) {
				return {
					ok: false,
					reason: `disk_low: ${freePercent.toFixed(1)}% free, floor ${opts.minFreePercent}%`,
				}
			}
		}
	}

	if (opts.storage) {
		try {
			await withTimeout(opts.storage.exists(STORAGE_PROBE_KEY), opts.storageTimeoutMs)
		} catch (err) {
			return {
				ok: false,
				reason: `storage_unavailable: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
	}

	return { ok: true }
}

// The session root may not exist yet on a fresh box; its nearest existing parent
// is on the same mount, so measure that.
async function readDiskFree(
	path: string,
): Promise<{ freeBytes: number; totalBytes: number } | null> {
	let current = path
	for (;;) {
		try {
			const s = await statfs(current)
			return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize }
		} catch {
			const parent = dirname(current)
			if (parent === current) return null
			current = parent
		}
	}
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
	})
	try {
		return await Promise.race([p, timeout])
	} finally {
		clearTimeout(timer)
	}
}
