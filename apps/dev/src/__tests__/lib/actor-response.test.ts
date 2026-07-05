import type { actors } from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeActor } from '../../lib/actor-response'
import { logger } from '../../lib/logger'

type ActorRow = typeof actors.$inferSelect

function buildRow(overrides: Partial<ActorRow> = {}): ActorRow {
	return {
		id: 'actor-1',
		type: 'human',
		name: 'Test Actor',
		email: 'test@example.com',
		apiKey: 'ank_test',
		passwordHash: null,
		description: null,
		bio: null,
		avatarStorageKey: null,
		notificationPrefs: null,
		pendingEmail: null,
		pendingEmailToken: null,
		pendingEmailExpiresAt: null,
		systemPrompt: null,
		tools: null,
		memory: null,
		llmProvider: null,
		llmConfig: null,
		isSystem: false,
		createdBy: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	} as ActorRow
}

describe('serializeActor — notification_prefs reshape', () => {
	let warnSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('serializes a malformed JSONB row with schema defaults and warns with the actor id', () => {
		// `mentions` declared as a string violates the boolean schema — drift / corrupt JSONB.
		const row = buildRow({
			id: 'actor-drifted',
			notificationPrefs: { mentions: 'yes please' } as unknown as ActorRow['notificationPrefs'],
		})

		const result = serializeActor(row)

		expect(result.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
		expect(warnSpy).toHaveBeenCalledOnce()
		const [msg, ctx] = warnSpy.mock.calls[0] as [string, Record<string, unknown>]
		expect(msg).toBe('Notification prefs schema mismatch')
		expect(ctx.actorId).toBe('actor-drifted')
		expect(Array.isArray(ctx.issues)).toBe(true)
		expect((ctx.issues as unknown[]).length).toBeGreaterThan(0)
	})

	it('stays silent and fills schema defaults when the JSONB is the bootstrap empty object', () => {
		const row = buildRow({
			notificationPrefs: {} as ActorRow['notificationPrefs'],
		})

		const result = serializeActor(row)

		expect(warnSpy).not.toHaveBeenCalled()
		expect(result.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
	})

	it('stays silent and fills schema defaults when notification_prefs is null', () => {
		const row = buildRow({ notificationPrefs: null })

		const result = serializeActor(row)

		expect(warnSpy).not.toHaveBeenCalled()
		expect(result.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
	})
})
