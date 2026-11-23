import { existsSync } from 'node:fs'

/**
 * Why the boot-time agent-base image warm-up should be skipped, or null when it
 * should run. Production routes sessions to the agent servers, so the main
 * server never builds the image; with no Docker socket the build could only fail.
 */
export function agentBaseWarmupSkipReason(
	env: NodeJS.ProcessEnv,
	socketExists: (path: string) => boolean = existsSync,
): string | null {
	if (env.NODE_ENV === 'production') return 'sessions run on the agent servers'
	if (env.MASKIN_DOCKER_UNAVAILABLE === '1') return 'Docker unavailable'

	// Same rule as scripts/lib/docker-absent-guard.sh: only unix sockets are tested,
	// a tcp:// or http:// DOCKER_HOST means a remote daemon.
	const host = env.DOCKER_HOST || 'unix:///var/run/docker.sock'
	if (host.includes('://') && !host.startsWith('unix://')) return null
	const socket = host.startsWith('unix://') ? host.slice('unix://'.length) : host
	return socketExists(socket) ? null : `no Docker socket at ${socket}`
}
