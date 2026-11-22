/**
 * Database watchdog: restarts the API process when the database has been unreachable for a
 * sustained time.
 *
 * Why: on 9-10 Nov the app's pooled connections went dead while Postgres sat idle, and the app
 * stayed down for 7 h 43 min until a human redeployed. The pool replacement in `@maskin/db` is the
 * real fix; this is the safety net. A restart builds a fresh pool, which is what the human did.
 *
 * Crash-loop risk: if the database is genuinely down, the process exits, restarts, waits out the
 * boot grace, fails for the threshold and exits again, so roughly every 3-8 minutes. That is
 * accepted: it is visible in the logs ("DB watchdog: database unreachable") and costs nothing the
 * outage has not already cost. Set DB_WATCHDOG=off to stop it.
 */

export const DB_WATCHDOG_INTERVAL_MS = 15_000
export const DB_WATCHDOG_PROBE_TIMEOUT_MS = 3_000
export const DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS = 180_000
export const DB_WATCHDOG_FAIL_AFTER_MIN_MS = 30_000
export const DB_WATCHDOG_FAIL_AFTER_MAX_MS = 1_800_000
/** A cold start or a migration may legitimately be slow, so never exit this soon after boot. */
export const DB_WATCHDOG_BOOT_GRACE_MS = 300_000
/** After asking for a graceful shutdown, exit anyway when it has not finished by then. */
export const DB_WATCHDOG_FORCE_EXIT_MS = 5_000

type Env = Record<string, string | undefined>

/** Off in tests, and when DB_WATCHDOG=off. */
export function isDbWatchdogEnabled(env: Env): boolean {
	if (env.NODE_ENV === 'test' || env.VITEST) return false
	return env.DB_WATCHDOG?.trim().toLowerCase() !== 'off'
}

/** DB_WATCHDOG_FAIL_AFTER_MS: a whole number of ms in 30 s to 30 min; anything else is the default. */
export function resolveDbWatchdogFailAfterMs(env: Env): number {
	const raw = env.DB_WATCHDOG_FAIL_AFTER_MS
	if (raw === undefined || raw.trim() === '') return DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS
	const n = Number(raw)
	return Number.isInteger(n) &&
		n >= DB_WATCHDOG_FAIL_AFTER_MIN_MS &&
		n <= DB_WATCHDOG_FAIL_AFTER_MAX_MS
		? n
		: DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS
}

export interface DbWatchdogOptions {
	/** Runs `SELECT 1` through the pool requests use. May hang; the watchdog bounds it. */
	probe: () => Promise<unknown>
	/** Starts the graceful shutdown. May hang or never return; it is not awaited. */
	shutdown: () => void
	/** Ends the process. Called after the grace period regardless of the shutdown. */
	forceExit: (code: number) => void
	logError: (message: string, fields: Record<string, unknown>) => void
	/** Queries sent to the pool and not yet answered, for the log line. */
	inFlightCount?: () => number
	failAfterMs?: number
	intervalMs?: number
	probeTimeoutMs?: number
	bootGraceMs?: number
	forceExitMs?: number
	now?: () => number
}

export interface DbWatchdog {
	stop: () => void
}

export function startDbWatchdog(opts: DbWatchdogOptions): DbWatchdog {
	const now = opts.now ?? Date.now
	const failAfterMs = opts.failAfterMs ?? DB_WATCHDOG_FAIL_AFTER_DEFAULT_MS
	const probeTimeoutMs = opts.probeTimeoutMs ?? DB_WATCHDOG_PROBE_TIMEOUT_MS
	const bootGraceMs = opts.bootGraceMs ?? DB_WATCHDOG_BOOT_GRACE_MS
	const forceExitMs = opts.forceExitMs ?? DB_WATCHDOG_FORCE_EXIT_MS
	const bootAt = now()

	let probing = false
	let failingSince: number | null = null
	let exiting = false

	async function probeOnce(): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				Promise.resolve().then(opts.probe),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`probe did not answer within ${probeTimeoutMs} ms`)),
						probeTimeoutMs,
					)
				}),
			])
			return true
		} catch {
			return false
		} finally {
			clearTimeout(timer)
		}
	}

	async function tick() {
		// The flag is released by `finally` after the race, and the race is bounded by the
		// timeout, so a probe that never settles cannot pin it (see reentrancy-flag-no-timeout).
		if (probing || exiting) return
		probing = true
		try {
			const ok = await probeOnce()
			const at = now()
			if (ok) {
				failingSince = null
				return
			}
			failingSince ??= at
			const failedForMs = at - failingSince
			if (failedForMs < failAfterMs || at - bootAt < bootGraceMs) return
			exiting = true
			opts.logError('DB watchdog: database unreachable, restarting the process', {
				failedForMs,
				failAfterMs,
				inFlight: opts.inFlightCount?.(),
			})
			setTimeout(() => opts.forceExit(1), forceExitMs)
			try {
				opts.shutdown()
			} catch {
				// The forced exit above still ends the process.
			}
		} finally {
			probing = false
		}
	}

	const handle = setInterval(() => void tick(), opts.intervalMs ?? DB_WATCHDOG_INTERVAL_MS)
	return { stop: () => clearInterval(handle) }
}
