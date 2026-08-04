import type { actors, triggers } from '@maskin/db/schema'
import { describe, expect, it } from 'vitest'
import {
	DEV_AGENT_PACKAGES,
	actorSnapshot,
	triggerSnapshot,
} from '../../../scripts/dev-agent-packages'

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

describe('Development Workspace single-agent package configs', () => {
	it('defines exactly 17 packages', () => {
		expect(DEV_AGENT_PACKAGES.length).toBe(17)
	})

	it('gives every package a slug, name, description, version, and use case', () => {
		const validUseCases = new Set(['Development', 'Discovery', 'Growth', 'Operations'])
		for (const config of DEV_AGENT_PACKAGES) {
			expect(config.package.slug.length).toBeGreaterThan(0)
			expect(config.package.name.length).toBeGreaterThan(0)
			expect(config.package.description.length).toBeGreaterThan(0)
			expect(config.package.version).toBe('1.0.0')
			expect(validUseCases.has(config.package.useCase)).toBe(true)
		}
	})

	it('groups packages into the four product-lifecycle use cases', () => {
		const useCaseBySlug = Object.fromEntries(
			DEV_AGENT_PACKAGES.map((c) => [c.package.slug, c.package.useCase]),
		)
		expect(useCaseBySlug).toMatchObject({
			planner: 'Development',
			developer: 'Development',
			architect: 'Development',
			designer: 'Development',
			'code-reviewer': 'Development',
			'workspace-driver': 'Development',
			'customer-feedback-agent': 'Discovery',
			'insights-triage-agent': 'Discovery',
			'product-ideator': 'Discovery',
			'research-agent': 'Discovery',
			'summarization-agent': 'Discovery',
			strategist: 'Growth',
			'product-analyst': 'Growth',
			'product-marketer': 'Growth',
			'product-pricing-specialist': 'Growth',
			'workspace-coach': 'Operations',
			'retro-knowledge-author': 'Operations',
		})
	})

	it('gives every package at least one actor and one trigger', () => {
		for (const config of DEV_AGENT_PACKAGES) {
			expect(config.actorIds.length).toBeGreaterThan(0)
			expect(config.triggerIds.length).toBeGreaterThan(0)
		}
	})

	it('has no duplicate slugs across packages', () => {
		const slugs = DEV_AGENT_PACKAGES.map((c) => c.package.slug)
		expect(new Set(slugs).size).toBe(slugs.length)
	})

	it('has no duplicate actor ids within or across packages', () => {
		const actorIds = DEV_AGENT_PACKAGES.flatMap((c) => c.actorIds)
		expect(new Set(actorIds).size).toBe(actorIds.length)
	})

	it('has no duplicate trigger ids within or across packages', () => {
		const triggerIds = DEV_AGENT_PACKAGES.flatMap((c) => c.triggerIds)
		expect(new Set(triggerIds).size).toBe(triggerIds.length)
	})
})

describe('actorSnapshot (re-exported from package-snapshot)', () => {
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
				name: 'Planner',
				systemPrompt: 'decompose bets into tasks',
				tools: { allowed: ['create_object'] },
			}),
		)
		expect(snap).toMatchObject({
			type: 'agent',
			name: 'Planner',
			systemPrompt: 'decompose bets into tasks',
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

describe('triggerSnapshot (re-exported from package-snapshot)', () => {
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
