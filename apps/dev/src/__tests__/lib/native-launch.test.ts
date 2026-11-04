import { beforeEach, describe, expect, it } from 'vitest'
import {
	NATIVE_LAUNCH_TTL_MS,
	decodeLaunchTicket,
	encodeLaunchTicket,
} from '../../lib/integrations/oauth/native-launch'
import { decodeState, encodeState } from '../../lib/integrations/oauth/state'

const base = {
	kind: 'native-launch' as const,
	provider: 'slack',
	nonce: 'abc123',
	installUrl: 'https://slack.com/oauth/v2/authorize?state=x',
}

describe('native launch ticket', () => {
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = 'a'.repeat(64)
	})

	it('round-trips a fresh ticket', () => {
		const now = Date.now()
		const t = decodeLaunchTicket(encodeLaunchTicket({ ...base, ts: now }), now + 1000)
		expect(t).toMatchObject(base)
	})

	it('rejects an expired ticket', () => {
		const now = Date.now()
		const raw = encodeLaunchTicket({ ...base, ts: now })
		expect(decodeLaunchTicket(raw, now + NATIVE_LAUNCH_TTL_MS + 1)).toBeNull()
	})

	it('rejects garbage and truncated input without throwing', () => {
		expect(decodeLaunchTicket('')).toBeNull()
		expect(decodeLaunchTicket('not-a-ticket')).toBeNull()
		const raw = encodeLaunchTicket({ ...base, ts: Date.now() })
		expect(decodeLaunchTicket(raw.slice(0, 20))).toBeNull()
	})

	it('does not accept an OAuth state as a ticket', () => {
		const state = encodeState({ workspaceId: 'w', actorId: 'a', ts: Date.now(), nonce: 'n' })
		expect(decodeLaunchTicket(state)).toBeNull()
	})

	it('is not a valid OAuth state either (never carries an actorId)', () => {
		const raw = encodeLaunchTicket({ ...base, ts: Date.now(), workspaceId: 'w' })
		const asState = decodeState(raw) as unknown as Record<string, unknown>
		expect(asState.actorId).toBeUndefined()
	})
})
