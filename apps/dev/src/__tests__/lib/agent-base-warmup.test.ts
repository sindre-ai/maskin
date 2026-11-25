import { describe, expect, it } from 'vitest'
import { agentBaseWarmupSkipReason } from '../../lib/agent-base-warmup'

const present = () => true
const absent = () => false

describe('agentBaseWarmupSkipReason', () => {
	it('skips in production even when a Docker socket exists', () => {
		expect(agentBaseWarmupSkipReason({ NODE_ENV: 'production' }, present)).toBe(
			'sessions run on the agent servers',
		)
	})

	it('skips when the no-Docker dev guard flagged Docker as unavailable', () => {
		expect(agentBaseWarmupSkipReason({ MASKIN_DOCKER_UNAVAILABLE: '1' }, present)).toBe(
			'Docker unavailable',
		)
	})

	it('skips when the default Docker socket is absent', () => {
		expect(agentBaseWarmupSkipReason({}, absent)).toBe('no Docker socket at /var/run/docker.sock')
	})

	it('checks the socket named by a unix DOCKER_HOST', () => {
		const seen: string[] = []
		const reason = agentBaseWarmupSkipReason({ DOCKER_HOST: 'unix:///tmp/d.sock' }, (p) => {
			seen.push(p)
			return false
		})
		expect(seen).toEqual(['/tmp/d.sock'])
		expect(reason).toBe('no Docker socket at /tmp/d.sock')
	})

	it('runs when the socket exists', () => {
		expect(agentBaseWarmupSkipReason({}, present)).toBeNull()
	})

	it('runs for a remote tcp DOCKER_HOST without testing a socket', () => {
		expect(agentBaseWarmupSkipReason({ DOCKER_HOST: 'tcp://10.0.0.1:2375' }, absent)).toBeNull()
	})
})
