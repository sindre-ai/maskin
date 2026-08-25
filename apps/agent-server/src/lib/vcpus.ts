import { cpus as osCpus } from 'node:os'

/**
 * vCPU sizing for session microVMs.
 *
 * libkrun boots a VM with a fixed vCPU count — unlike a Docker container, which
 * gets a *relative weight* (`CpuShares`) and bursts across whatever cores are
 * idle. So the number handed to `msb create --cpus` is a hard ceiling, and it
 * must not be derived from `cpu_shares`: that value is a weight, and reading it
 * as a core count is what silently pinned every session to one vCPU.
 *
 * One vCPU per session is the deliberate default. An agent session is dominated
 * by waiting on the LLM, so the box is filled by running *more* sessions rather
 * than widening each one — see lib/capacity.ts for that half. A session that
 * genuinely needs more can pin `vcpus` in its config.
 */

export const DEFAULT_SESSION_VCPUS = 1

function clamp(n: number, min: number, max: number): number {
	return Math.min(Math.max(n, min), max)
}

/** Cores visible to this host, floored at 1 so sizing math can't produce 0. */
export function hostCoreCount(): number {
	return Math.max(1, osCpus().length)
}

/**
 * Final vCPU count for a session: an explicit request clamped to what the host
 * physically has, or the one-vCPU default.
 */
export function resolveSessionVcpus(requested: number | undefined, hostCores: number): number {
	if (requested !== undefined && Number.isInteger(requested) && requested > 0) {
		return clamp(requested, 1, hostCores)
	}
	return DEFAULT_SESSION_VCPUS
}
