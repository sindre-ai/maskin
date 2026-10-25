import { api } from '@/lib/api'

// Client-side cache for the backend-resolved flags (GET /api/feature-flags).
//
// Reads are synchronous for callers: the module seeds itself from localStorage
// at import time and revalidates in the background, so a repeat visit renders
// the right UI immediately instead of flashing the wrong one.
//
// Failure policy, in order: last cached value → all flags false. An outage of
// the flags endpoint must never white-screen the app or throw.

// Versioned — bump the suffix to invalidate every client's cache if the
// response shape changes. Versioned the way every persisted client cache here is.
// The answer depends on the workspace (workspace-scoped flags), so the cache is
// keyed by workspace id; with no workspace selected it is the actor-only answer.
const STORAGE_KEY_BASE = 'maskin-feature-flags:2'

function storageKey(workspaceId: string | null): string {
	return workspaceId ? `${STORAGE_KEY_BASE}:${workspaceId}` : STORAGE_KEY_BASE
}

// TEST-ONLY override. `localStorage['ff:<flagId>'] = 'on' | 'off'` beats the
// server response, so Playwright can drive both sides of a flag boundary in one
// run without seeding a second actor. This is NOT a user-facing mechanism:
// testers get their flags automatically from FF_TESTER_ACTOR_IDS on login, on
// every device, with no client-side action.
const OVERRIDE_PREFIX = 'ff:'

type Flags = Record<string, boolean>

function readCache(workspaceId: string | null): Flags | null {
	try {
		const raw = localStorage.getItem(storageKey(workspaceId))
		if (!raw) return null
		const parsed = JSON.parse(raw)
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
		const flags: Flags = {}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value === 'boolean') flags[key] = value
		}
		return flags
	} catch {
		// Unparseable or unavailable storage falls through to all-false.
		return null
	}
}

function writeCache(workspaceId: string | null, flags: Flags): void {
	try {
		localStorage.setItem(storageKey(workspaceId), JSON.stringify(flags))
	} catch {
		// Caching is best-effort; a full or privacy-mode storage must never throw.
	}
}

function readOverride(flagId: string): boolean | null {
	try {
		const raw = localStorage.getItem(`${OVERRIDE_PREFIX}${flagId}`)
		if (raw === 'on') return true
		if (raw === 'off') return false
		return null
	} catch {
		return null
	}
}

let currentWorkspaceId: string | null = null
let cachedFlags: Flags = readCache(null) ?? {}
let hasCache = readCache(null) !== null
const listeners = new Set<() => void>()

function notify(): void {
	for (const listener of listeners) listener()
}

/** Points the cache at one workspace's answer, seeding synchronously from that
 *  workspace's stored copy so a repeat visit still renders without a flash. Call
 *  it before reading flags on a workspace route; a no-op when nothing changes. */
export function setFlagsWorkspace(workspaceId: string | null | undefined): void {
	const next = workspaceId ?? null
	if (next === currentWorkspaceId) return
	currentWorkspaceId = next
	const stored = readCache(next)
	cachedFlags = stored ?? {}
	hasCache = stored !== null
	notify()
}

/** True when a previous successful response is available, so the caller can
 *  render immediately and revalidate in the background instead of awaiting. */
export function hasCachedFlags(): boolean {
	return hasCache
}

/** Synchronous read. Unknown flag ids — and every flag before the first ever
 *  successful fetch — are false. Never undefined, never throws. */
export function getFlag(flagId: string): boolean {
	const override = readOverride(flagId)
	if (override !== null) return override
	return cachedFlags[flagId] === true
}

let inFlight: { workspaceId: string | null; promise: Promise<void> } | null = null

/** Fetches and caches the resolved flags for the selected workspace. Never
 *  rejects: on any failure it logs and leaves the currently seeded values in
 *  place. */
export function loadFeatureFlags(): Promise<void> {
	const workspaceId = currentWorkspaceId
	if (inFlight && inFlight.workspaceId === workspaceId) return inFlight.promise
	const promise: Promise<void> = api.featureFlags
		.get(workspaceId ?? undefined)
		.then((res) => {
			const flags = res?.flags
			if (!flags || typeof flags !== 'object') return
			writeCache(workspaceId, flags)
			// The user may have moved to another workspace while this was in flight.
			if (workspaceId !== currentWorkspaceId) return
			cachedFlags = flags
			hasCache = true
			notify()
		})
		.catch((error) => {
			console.error('[maskin] failed to load feature flags', error)
		})
		.finally(() => {
			if (inFlight?.promise === promise) inFlight = null
		})
	inFlight = { workspaceId, promise }
	return promise
}

/** Subscription for useSyncExternalStore, so a background revalidation that
 *  changes a value re-renders the boundary. */
export function subscribeToFlags(listener: () => void): () => void {
	listeners.add(listener)
	return () => {
		listeners.delete(listener)
	}
}

/** Test-only: reset module state between cases. */
export function _resetFeatureFlags(): void {
	currentWorkspaceId = null
	cachedFlags = readCache(null) ?? {}
	hasCache = readCache(null) !== null
	inFlight = null
	listeners.clear()
}
