import { API_BASE } from './constants'

// Whether the Maskin server is answering — distinct from `navigator.onLine`,
// which only knows the device has a network. A deploy, a crash loop or a proxy
// with no healthy backend leaves the browser "online" while every /api call
// comes back 502/503/504, and until now nothing told the person why.
//
// Callers report evidence (`reportServerFailure` / `reportServerOk`); this module
// decides. A failure alone never raises the banner: after FAILURES_BEFORE_PROBE
// in a row it asks /api/health, and only a failed probe marks the server
// unreachable. That keeps one slow endpoint's 504 from alarming anybody.
//
// While unreachable it keeps probing with backoff (and immediately on focus or
// when the network returns), and on the first good answer runs the recovery
// handlers so screens that gave up can try again without a manual reload.

const FAILURES_BEFORE_PROBE = 2
const PROBE_BASE_MS = 5_000
const PROBE_MAX_MS = 30_000
const PROBE_TIMEOUT_MS = 5_000

export interface ServerReachability {
	unreachable: boolean
	/** When the server last answered; null until it has, this page load. */
	lastOkAt: number | null
}

let snapshot: ServerReachability = { unreachable: false, lastOkAt: null }
let lastOkAt: number | null = null
let failures = 0
let probing = false
let probeAttempts = 0
let probeTimer: ReturnType<typeof setTimeout> | null = null

const listeners = new Set<() => void>()
const recoveryHandlers = new Set<() => void>()

function publish(next: ServerReachability) {
	snapshot = next
	for (const listener of listeners) listener()
}

export function subscribeServerReachability(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

export function getServerReachability(): ServerReachability {
	return snapshot
}

/** Runs once each time the server goes from unreachable to answering. */
export function onServerRecovered(handler: () => void): () => void {
	recoveryHandlers.add(handler)
	return () => {
		recoveryHandlers.delete(handler)
	}
}

async function probeHealth(): Promise<boolean> {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
	try {
		const res = await fetch(`${API_BASE}/health`, {
			cache: 'no-store',
			signal: controller.signal,
		})
		return res.ok
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

function clearProbeTimer() {
	if (probeTimer !== null) {
		clearTimeout(probeTimer)
		probeTimer = null
	}
}

function probeNow() {
	if (!snapshot.unreachable) return
	clearProbeTimer()
	void runProbe()
}

function onWake() {
	if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
	probeNow()
}

function watchForWake() {
	window.addEventListener('focus', onWake)
	window.addEventListener('online', onWake)
	document.addEventListener('visibilitychange', onWake)
}

function stopWatchingForWake() {
	window.removeEventListener('focus', onWake)
	window.removeEventListener('online', onWake)
	document.removeEventListener('visibilitychange', onWake)
}

function markUnreachable() {
	probeAttempts = 0
	publish({ unreachable: true, lastOkAt })
	watchForWake()
	scheduleProbe()
}

function markRecovered() {
	clearProbeTimer()
	stopWatchingForWake()
	failures = 0
	probeAttempts = 0
	lastOkAt = Date.now()
	publish({ unreachable: false, lastOkAt })
	for (const handler of [...recoveryHandlers]) {
		try {
			handler()
		} catch (err) {
			console.error('[server-reachability] recovery handler failed', err)
		}
	}
}

function scheduleProbe() {
	clearProbeTimer()
	const delay = Math.min(PROBE_BASE_MS * 2 ** probeAttempts, PROBE_MAX_MS)
	probeAttempts += 1
	probeTimer = setTimeout(() => void runProbe(), delay)
}

async function runProbe() {
	if (probing) return
	probing = true
	try {
		const ok = await probeHealth()
		if (ok) {
			if (snapshot.unreachable) markRecovered()
			else failures = 0
			return
		}
		if (!snapshot.unreachable) markUnreachable()
		else scheduleProbe()
	} finally {
		probing = false
	}
}

/**
 * A request got a 502/503/504 from a gateway (not from our API) or never got an
 * answer. Ignored while the device itself is offline — the offline banner covers
 * that and a dead network says nothing about the server.
 */
export function reportServerFailure(): void {
	if (typeof navigator !== 'undefined' && navigator.onLine === false) return
	if (snapshot.unreachable) return
	failures += 1
	if (failures >= FAILURES_BEFORE_PROBE) void runProbe()
}

/** Any real answer from the server, success or an ordinary 4xx. */
export function reportServerOk(): void {
	failures = 0
	lastOkAt = Date.now()
	if (snapshot.unreachable) {
		clearProbeTimer()
		markRecovered()
	}
}

/** Test-only — returns the module to its first-load state. */
export function __resetServerReachabilityForTesting(): void {
	clearProbeTimer()
	stopWatchingForWake()
	listeners.clear()
	recoveryHandlers.clear()
	snapshot = { unreachable: false, lastOkAt: null }
	lastOkAt = null
	failures = 0
	probing = false
	probeAttempts = 0
}
