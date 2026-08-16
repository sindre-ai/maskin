import type { actors, triggers, workspaceSkills } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import {
	CCD_ACTOR_IDS,
	CCD_LOOP,
	CCD_SKILL_IDS,
	CCD_TRIGGER_IDS,
	actorSnapshot,
	skillSnapshot,
	triggerSnapshot,
} from '../../../lib/marketplace-loops/ccd-loop'

type ActorRow = typeof actors.$inferSelect
type TriggerRow = typeof triggers.$inferSelect
type SkillRow = typeof workspaceSkills.$inferSelect

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
		metadata: { installed_loop_id: '00000000-0000-0000-0000-000000000000' },
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
		metadata: { installed_loop_id: '00000000-0000-0000-0000-000000000000' },
		createdBy: '11111111-1111-4111-9111-111111111111',
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
	}
	return { ...base, ...over }
}

function fakeSkill(over: Partial<SkillRow> = {}): SkillRow {
	const base: SkillRow = {
		id: '33333333-3333-4333-9333-333333333333',
		workspaceId: 'fe944fe6-7b45-478c-afc7-b889cea63c08',
		name: 'codebase-review',
		description: 'Review code for correctness and style.',
		content: '# Codebase Review\n\nDo the review.',
		storageKey: 'workspaces/fe944fe6-7b45-478c-afc7-b889cea63c08/skills/live-skill/SKILL.md',
		sizeBytes: 34,
		isValid: true,
		isFolder: false,
		fileCount: null,
		metadata: { installed_loop_id: '00000000-0000-0000-0000-000000000000' },
		createdBy: null,
		createdAt: new Date('2026-01-01'),
		updatedAt: new Date('2026-01-01'),
	}
	return { ...base, ...over }
}

describe('Discover & Research Loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(CCD_LOOP.slug).toBe('discover-research-loop')
		expect(CCD_LOOP.name).toBe('Discover & Research Loop')
		expect(CCD_LOOP.useCase).toBe('Discovery')
		expect(CCD_LOOP.version).toBe('1.0.0')
		expect(CCD_LOOP.description.length).toBeGreaterThan(0)
		expect(CCD_LOOP.description).toMatch(/feedback/)
	})

	it('ships five actors and fourteen triggers, no duplicates', () => {
		expect(CCD_ACTOR_IDS.length).toBe(5)
		expect(CCD_TRIGGER_IDS.length).toBe(14)
		expect(new Set(CCD_ACTOR_IDS).size).toBe(CCD_ACTOR_IDS.length)
		expect(new Set(CCD_TRIGGER_IDS).size).toBe(CCD_TRIGGER_IDS.length)
	})

	it('gives CCD_SKILL_IDS an array shape, deduped — a skill may be shared across actors', () => {
		expect(Array.isArray(CCD_SKILL_IDS)).toBe(true)
		expect(new Set(CCD_SKILL_IDS).size).toBe(CCD_SKILL_IDS.length)
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

	it('strips tools.mcpServers so live credentials never reach the snapshot', () => {
		const snap = actorSnapshot(
			fakeActor({
				tools: {
					allowed: ['create_object'],
					mcpServers: {
						github: {
							type: 'stdio',
							command: 'npx',
							env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_live_secret_do_not_leak' },
						},
					},
				},
			}),
		)
		const tools = snap.tools as Record<string, unknown>
		expect(tools).not.toHaveProperty('mcpServers')
		expect(tools.allowed).toEqual(['create_object'])
		expect(JSON.stringify(snap)).not.toContain('ghp_live_secret_do_not_leak')
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

describe('skillSnapshot', () => {
	it('omits id, workspaceId, storageKey, sizeBytes, createdBy, metadata, timestamps', () => {
		const snap = skillSnapshot(fakeSkill(), [])
		expect(snap).not.toHaveProperty('id')
		expect(snap).not.toHaveProperty('workspaceId')
		expect(snap).not.toHaveProperty('storageKey')
		expect(snap).not.toHaveProperty('sizeBytes')
		expect(snap).not.toHaveProperty('createdBy')
		expect(snap).not.toHaveProperty('metadata')
		expect(snap).not.toHaveProperty('createdAt')
		expect(snap).not.toHaveProperty('updatedAt')
	})

	it('never carries the publisher storageKey — install always mints a fresh S3 key', () => {
		const snap = skillSnapshot(
			fakeSkill({ storageKey: 'workspaces/publisher-ws/skills/leak/SKILL.md' }),
			[],
		)
		expect(JSON.stringify(snap)).not.toContain('publisher-ws')
	})

	it('embeds the attachedActorIds passed in, for the install-time agent_skills join', () => {
		const actorId = '11111111-1111-4111-9111-111111111111'
		const snap = skillSnapshot(fakeSkill(), [actorId])
		expect(snap.attachedActorIds).toEqual([actorId])
	})

	it('carries name, description, content, and isValid through verbatim', () => {
		const snap = skillSnapshot(
			fakeSkill({ name: 'my-skill', description: 'desc', content: '# body', isValid: false }),
			[],
		)
		expect(snap.name).toBe('my-skill')
		expect(snap.description).toBe('desc')
		expect(snap.content).toBe('# body')
		expect(snap.isValid).toBe(false)
	})
})
