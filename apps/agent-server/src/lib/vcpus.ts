import { cpus as osCpus } from 'node:os'

/**
 * vCPU sizing for session microVMs.
 *
 * libkrun boots a VM with a fixed vCPU count — unlike a Docker container, which
 * gets a *relative weight* (`CpuShares`) and can burst across every core the
 * host has idle. So the number handed to `msb create --cpus` is a hard ceiling
 * on how much of the box one session can ever use, and picking it badly is
 * invisible: the session just runs slowly.
 *
 * apps/dev can't pick it, because it doesn't know how big any given agent-server
 * box is. So the box picks its own default from its own core count, and apps/dev
 * only overrides when a session config asks for a specific size.
 */

// Cores held back for everything that isn't a session VM: agent-server itself,
// the msb supervisor, and whatever else shares the host.
const RESERVED_HOST_CORES = 2

// Ceiling on the *default*. On a very large box we'd rather run more sessions
// concurrently than let one session claim 32 vCPUs it will leave idle. An
// explicit request may still exceed this, up to the host's core count.
export const MAX_DEFAULT_SESSION_VCPUS = 8

// Chromium + Xvfb are multi-threaded; one vCPU makes page loads crawl and is a
// common cause of Playwright timeouts in the sidecar.
const BROWSER_SIDECAR_VCPUS = 2

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max)
}

/** Cores visible to this host, floored at 1 so sizing math can't produce 0. */
export function hostCoreCount(): number {
	return Math.max(1, osCpus().length)
}

/**
 * vCPUs to give a session that didn't ask for a specific size: everything but
 * the reserved host cores, capped at MAX_DEFAULT_SESSION_VCPUS.
 *
 * `override` is MSB_DEFAULT_VCPUS, already parsed by env.ts. It wins outright
 * (still clamped to the host's core count) so a box can be tuned by restarting
 * agent-server rather than shipping a release.
 */
export function defaultSessionVcpus(hostCores: number, override?: number): number {
	if (override !== undefined && Number.isInteger(override) && override > 0) {
		return clamp(override, 1, hostCores)
	}
	return clamp(hostCores - RESERVED_HOST_CORES, 1, MAX_DEFAULT_SESSION_VCPUS)
}

/**
 * Final vCPU count for a session: an explicit request clamped to what the host
 * physically has, or the host default when nothing was requested.
 */
export function resolveSessionVcpus(
	requested: number | undefined,
	hostCores: number,
	fallback?: number,
): number {
	if (requested !== undefined && Number.isInteger(requested) && requested > 0) {
		return clamp(requested, 1, hostCores)
	}
	return fallback !== undefined && Number.isInteger(fallback) && fallback > 0
		? clamp(fallback, 1, hostCores)
		: defaultSessionVcpus(hostCores)
}

/** vCPUs for the Chromium CDP sidecar, never more than the host has. */
export function browserSidecarVcpus(hostCores: number): number {
	return clamp(BROWSER_SIDECAR_VCPUS, 1, hostCores)
}
