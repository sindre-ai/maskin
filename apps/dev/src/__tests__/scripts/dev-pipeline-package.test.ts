import type { actors, triggers } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import {
	DEV_PIPELINE_ACTOR_IDS,
	DEV_PIPELINE_PACKAGE,
	DEV_PIPELINE_TRIGGER_IDS,
	actorSnapshot,
	triggerSnapshot,
} from '../../../scripts/dev-pipeline-package'

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
		llmConfig: { model: 'claude-sonnet-4-6' },
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
		config: { entity_type: 'task', action: 'status_changed', to_status: 'in_progress' },
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

describe('Development Pipeline package definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(DEV_PIPELINE_PACKAGE.slug).toBe('development-pipeline')
		expect(DEV_PIPELINE_PACKAGE.name).toBe('Development Pipeline')
		expect(DEV_PIPELINE_PACKAGE.useCase).toBe('Development')
		expect(DEV_PIPELINE_PACKAGE.version).toBe('1.0.0')
		expect(DEV_PIPELINE_PACKAGE.description.length).toBeGreaterThan(0)
	})

	it('ships three actors and four triggers, no duplicates', () => {
		expect(DEV_PIPELINE_ACTOR_IDS.length).toBe(3)
		expect(DEV_PIPELINE_TRIGGER_IDS.length).toBe(4)
		expect(new Set(DEV_PIPELINE_ACTOR_IDS).size).toBe(DEV_PIPELINE_ACTOR_IDS.length)
		expect(new Set(DEV_PIPELINE_TRIGGER_IDS).size).toBe(DEV_PIPELINE_TRIGGER_IDS.length)
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
				name: 'Developer',
				systemPrompt: 'implement things',
				tools: { allowed: ['create_object'] },
			}),
		)
		expect(snap).toMatchObject({
			type: 'agent',
			name: 'Developer',
			systemPrompt: 'implement things',
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
