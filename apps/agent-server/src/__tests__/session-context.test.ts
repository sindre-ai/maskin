import { describe, expect, it } from 'vitest'
import { readSessionActorContext } from '../lib/session-context'

const ACTOR_ID = '9f1e7a53-2b8c-4d0e-8a3f-6c0b71d5e924'
const API_KEY = 'ank_deadbeefcafef00d0123456789abcdef'

describe('readSessionActorContext', () => {
	// The confirmation this whole file exists for: given the pair apps/dev
	// injects for a loop-driven session, the actor identity round-trips out
	// again untouched. This is the driver-actor id the receiving Hono route
	// resolves from MASKIN_API_KEY via packages/auth/authMiddleware.
	it('returns the driver-actor context when both vars are present and well-shaped', () => {
		const ctx = readSessionActorContext({
			MASKIN_ACTOR_ID: ACTOR_ID,
			MASKIN_API_KEY: API_KEY,
		})
		expect(ctx).toEqual({ actorId: ACTOR_ID, apiKey: API_KEY })
	})

	it('trims surrounding whitespace on both fields', () => {
		const ctx = readSessionActorContext({
			MASKIN_ACTOR_ID: `  ${ACTOR_ID}  `,
			MASKIN_API_KEY: `  ${API_KEY}\n`,
		})
		expect(ctx).toEqual({ actorId: ACTOR_ID, apiKey: API_KEY })
	})

	// Interactive human-driven sessions don't set these — return null instead
	// of throwing so the caller can branch on presence.
	it('returns null when neither var is set', () => {
		expect(readSessionActorContext({})).toBeNull()
	})

	it('returns null when only MASKIN_ACTOR_ID is set', () => {
		expect(readSessionActorContext({ MASKIN_ACTOR_ID: ACTOR_ID })).toBeNull()
	})

	it('returns null when only MASKIN_API_KEY is set', () => {
		expect(readSessionActorContext({ MASKIN_API_KEY: API_KEY })).toBeNull()
	})

	it('returns null when MASKIN_ACTOR_ID is blank after trimming', () => {
		expect(readSessionActorContext({ MASKIN_ACTOR_ID: '   ', MASKIN_API_KEY: API_KEY })).toBeNull()
	})

	it('returns null when MASKIN_API_KEY is blank after trimming', () => {
		expect(readSessionActorContext({ MASKIN_ACTOR_ID: ACTOR_ID, MASKIN_API_KEY: '   ' })).toBeNull()
	})

	// Guards against a bad env writer stuffing an actor label or session id
	// where a UUID was expected — the actorMiddleware lookup would fail later,
	// but rejecting at the boundary keeps the failure mode close to its cause.
	it('returns null when MASKIN_ACTOR_ID is not a UUID', () => {
		expect(
			readSessionActorContext({ MASKIN_ACTOR_ID: 'not-a-uuid', MASKIN_API_KEY: API_KEY }),
		).toBeNull()
	})

	// Guards against a token from a different scheme (e.g. a Better Auth
	// session cookie) being handed to a route that only accepts `ank_` keys.
	it('returns null when MASKIN_API_KEY does not have the ank_ prefix', () => {
		expect(
			readSessionActorContext({
				MASKIN_ACTOR_ID: ACTOR_ID,
				MASKIN_API_KEY: 'session-cookie-value',
			}),
		).toBeNull()
	})

	it('accepts uppercase UUIDs (packages/auth normalises them case-insensitively)', () => {
		const ctx = readSessionActorContext({
			MASKIN_ACTOR_ID: ACTOR_ID.toUpperCase(),
			MASKIN_API_KEY: API_KEY,
		})
		expect(ctx?.actorId).toBe(ACTOR_ID.toUpperCase())
	})

	it('never throws on an env with additional unrelated keys', () => {
		const ctx = readSessionActorContext({
			MASKIN_ACTOR_ID: ACTOR_ID,
			MASKIN_API_KEY: API_KEY,
			PATH: '/usr/bin',
			NODE_ENV: 'production',
			AGENT_SERVER_URL: 'http://host.microsandbox.internal:3001',
		})
		expect(ctx).toEqual({ actorId: ACTOR_ID, apiKey: API_KEY })
	})
})
