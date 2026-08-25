import { totalmem } from 'node:os'
import { hostCoreCount } from './vcpus'

/**
 * How many sessions this box can run at once.
 *
 * apps/dev can't answer this: `AGENT_SERVER_MAX_SESSIONS` is one flat number
 * shared by every registered agent-server, and nothing in apps/dev knows how
 * many cores or how much RAM any particular box has. A number picked that way
 * is either far below what the hardware can do (the box idles) or far above it
 * (the box thrashes) — at the old default of 50 and a 4 GiB session budget it
 * promised 200 GiB on a 62 GiB machine.
 *
 * So the box computes its own limit from its own hardware and reports it on
 * boot (see reconcileOnBoot), and apps/dev stores it as the server's
 * `max_concurrent_sessions`. Both bounds have to hold:
 *
 *   - CPU: one vCPU per session (see lib/vcpus.ts), minus cores held back for
 *     host services, so a full box still has room to schedule agentd, the
 *     log-flush loop, and everything else that isn't a session.
 *   - RAM: microVM memory is really committed, unlike vCPUs which are only
 *     timeshared. Overcommitting it is what actually takes a box down, so this
 *     is the bound that usually binds.
 */

// Cores held back for agent-server itself, msb/agentd, and other host services.
const RESERVED_HOST_CORES = 2

// RAM held back for the same, plus page cache. Generous on purpose: the cost of
// being wrong here is an OOM kill of a live session, not a slow session.
const RESERVED_HOST_MIB = 8192

// Must track `memory_mb`'s default in packages/shared/src/schemas/sessions.ts —
// apps/dev sends that per session and this side has no way to know it in
// advance. Overridable via SESSION_MEMORY_BUDGET_MIB when a deployment changes
// the session default.
export const DEFAULT_SESSION_MEMORY_MIB = 4096

export type CapacityInputs = {
	hostCores: number
	totalMemoryMib: number
	sessionMemoryMib: number
	/** MSB_MAX_SESSIONS — an explicit operator override, already parsed. */
	override?: number
}

export type CapacityResult = {
	capacity: number
	cpuBound: number
	memoryBound: number
	/** Which input decided the number — reported in the boot log. */
	boundBy: 'cpu' | 'memory' | 'override'
}

/**
 * The lower of the CPU and RAM bounds, floored at 1 so even a tiny box can run
 * something rather than registering as permanently full.
 */
export function computeSessionCapacity(inputs: CapacityInputs): CapacityResult {
	const cpuBound = Math.max(1, inputs.hostCores - RESERVED_HOST_CORES)
	const usableMib = inputs.totalMemoryMib - RESERVED_HOST_MIB
	const memoryBound = Math.max(1, Math.floor(usableMib / Math.max(1, inputs.sessionMemoryMib)))

	if (inputs.override !== undefined && Number.isInteger(inputs.override) && inputs.override > 0) {
		return { capacity: inputs.override, cpuBound, memoryBound, boundBy: 'override' }
	}

	const capacity = Math.min(cpuBound, memoryBound)
	return {
		capacity,
		cpuBound,
		memoryBound,
		boundBy: capacity === cpuBound ? 'cpu' : 'memory',
	}
}

/** computeSessionCapacity() applied to this actual host. */
export function localSessionCapacity(opts: {
	sessionMemoryMib?: number
	override?: number
}): CapacityResult {
	return computeSessionCapacity({
		hostCores: hostCoreCount(),
		totalMemoryMib: Math.floor(totalmem() / (1024 * 1024)),
		sessionMemoryMib: opts.sessionMemoryMib ?? DEFAULT_SESSION_MEMORY_MIB,
		...(opts.override !== undefined && { override: opts.override }),
	})
}
