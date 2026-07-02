import type { actors, triggers } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import {
	CCD_ACTOR_IDS,
	CCD_PACKAGE,
	CCD_TRIGGER_IDS,
	actorSnapshot,
	triggerSnapshot,
} from '../../../scripts/ccd-package'

type ActorRow = typeof actors.$inferSelect
type TriggerRow = typeof triggers.$inferSelect

function fakeActor(over: Partial<ActorRow> = {}): ActorRow {
	const base: ActorRow = {
		id: '11111111-1111-4111-9111-111111111111',
		type: 'agent',
		name: 'Test Agent',
		email: null,
		apiKey: 'ank_DO_NOT_LEAK_ME',
		passwordHash: 'hashed-secret',
		description: 'desc',
		systemPrompt: 'prompt',
		tools: { allowed: ['done'] },
		memory: { jobs_done: 42 },
		llmProvider: 'anthropic',
		llmConfig: { model: 'claude-opus-4-7' },
		isSystem: false,
		agentState: 'idle',
		agentStateUpdatedAt: new Date('2026-01-01'),
		metadata: { installed_package_id: '00000000-0000-0000-0000-000000000000' },
		createdBy: null,
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
	}
	return { ...base, ...over }
}

function fakeTrigger(over: Partial<TriggerRow> = {}): TriggerRow {
	const base: TriggerRow = {
		id: '22222222-2222-4222-9222-222222222222',
		workspaceId: 'fe944fe6-7b45-478c-afc7-b889cea63c08',
		name: 'Trigger',
		type: 'event',
		config: { entity_type: 'insight', action: 'created' },
		actionPrompt: 'do the thing',
		targetActorId: '11111111-1111-4111-9111-111111111111',
		enabled: true,
		metadata: { installed_package_id: '00000000-0000-0000-0000-000000000000' },
		createdBy: '11111111-1111-4111-9111-111111111111',
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
	}
	return { ...base, ...over }
}

describe('CCD package definition', () => {
	it('uses the locked T6 copy', () => {
		expect(CCD_PACKAGE.slug).toBe('customer-continuous-discovery')
		expect(CCD_PACKAGE.name).toBe('Customer Continuous Discovery')
		expect(CCD_PACKAGE.useCase).toBe('Discovery')
		expect(CCD_PACKAGE.version).toBe('1.0.0')
		expect(CCD_PACKAGE.description.length).toBeLessThanOrEqual(120)
		expect(CCD_PACKAGE.description).toMatch(/feedback/)
	})

	it('ships four actors and nine triggers, no duplicates', () => {
		expect(CCD_ACTOR_IDS.length).toBe(4)
		expect(CCD_TRIGGER_IDS.length).toBe(9)
		expect(new Set(CCD_ACTOR_IDS).size).toBe(CCD_ACTOR_IDS.length)
		expect(new Set(CCD_TRIGGER_IDS).size).toBe(CCD_TRIGGER_IDS.length)
	})
})

describe('actorSnapshot', () => {
	it('omits credentials and runtime state', () => {
		const snap = actorSnapshot(fakeActor())
		expect(snap).not.toHaveProperty('apiKey')
		expect(snap).not.toHaveProperty('passwordHash')
		expect(snap).not.toHaveProperty('memory')
		expect(snap).not.toHaveProperty('agentState')
		expect(snap).not.toHaveProperty('agentStateUpdatedAt')
		expect(snap).not.toHaveProperty('metadata')
		expect(snap).not.toHaveProperty('createdAt')
		expect(snap).not.toHaveProperty('createdBy')
		expect(snap).not.toHaveProperty('id')
	})

	it('preserves config that survives a re-install', () => {
		const snap = actorSnapshot(
			fakeActor({
				type: 'agent',
				name: 'Insights Triage Agent',
				systemPrompt: 'cluster things',
				tools: { allowed: ['create_object'] },
			}),
		)
		expect(snap).toMatchObject({
			type: 'agent',
			name: 'Insights Triage Agent',
			systemPrompt: 'cluster things',
			tools: { allowed: ['create_object'] },
			llmProvider: 'anthropic',
		})
	})
})

describe('triggerSnapshot', () => {
	it('omits workspace, createdBy, metadata, timestamps', () => {
		const snap = triggerSnapshot(fakeTrigger())
		expect(snap).not.toHaveProperty('workspaceId')
		expect(snap).not.toHaveProperty('createdBy')
		expect(snap).not.toHaveProperty('metadata')
		expect(snap).not.toHaveProperty('id')
		expect(snap).not.toHaveProperty('createdAt')
		expect(snap).not.toHaveProperty('updatedAt')
	})

	it('carries targetActorId verbatim so install can rewrite via source_item_id', () => {
		const actorId = '11111111-1111-4111-9111-111111111111'
		const snap = triggerSnapshot(fakeTrigger({ targetActorId: actorId }))
		expect(snap.targetActorId).toBe(actorId)
	})
})
