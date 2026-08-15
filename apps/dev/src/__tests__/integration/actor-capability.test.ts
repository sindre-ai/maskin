import { agentSkills, integrations, workspaceMembers, workspaceSkills } from '@maskin/db/schema'
import {
	buildIntegration,
	buildWorkspaceSkill,
	insertActor,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')

function createApp() {
	return createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
}

describe('Actors Integration — GET /:id capability', () => {
	it('returns null capability for human actors', async () => {
		const app = createApp()
		const human = await insertActor(db, { type: 'human', name: 'Some Human' })

		const res = await app.request(jsonGet(`/api/actors/${human.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.capability).toBeNull()
	})

	it('scores a bare agent with no skills or triggers as Novice with actionable gaps', async () => {
		const app = createApp()
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Bare Agent',
			systemPrompt: 'You are a bot.',
		})

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.capability).not.toBeNull()
		expect(body.capability.version).toBe(1)
		expect(body.capability.overall.level).toBe('novice')
		expect(body.capability.overall.score).toBeLessThanOrEqual(19)
		expect(body.capability.topGaps.length).toBeGreaterThanOrEqual(3)
		for (const gap of body.capability.topGaps) {
			expect(typeof gap.action).toBe('string')
			expect(gap.action.length).toBeGreaterThan(0)
			expect(typeof gap.dimension).toBe('string')
		}
	})

	it('lifts an agent with two skills and a trigger to Practitioner or higher', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Working Agent',
			description: 'Handles routine tasks',
			systemPrompt:
				// Substantial prompt so the Expertise dimension clears the >800 char /
				// ≥3 heading floor while staying below the ≥2000 char / examples floor.
				[
					'# Role',
					'You are a workspace copilot that keeps ongoing initiatives moving.',
					'',
					'# Scope',
					'You handle recurring status updates, draft summaries of recent activity, and answer questions about workspace state. You do not run destructive operations.',
					'',
					'# Decision framework',
					'When asked to act, prefer additive updates over destructive ones. When information is missing, ask the human before guessing. Cite the source object for every claim.',
					'',
					'# Output format',
					'Return short paragraphs with markdown links to any referenced objects.',
				].join('\n'),
			llmProvider: 'anthropic',
			llmConfig: { model: 'claude-sonnet-4-6' },
		})
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: agent.id,
			role: 'member',
		})

		const [skill1] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId: ws.id, createdBy: getTestActorId() }))
			.returning()
		const [skill2] = await db
			.insert(workspaceSkills)
			.values(buildWorkspaceSkill({ workspaceId: ws.id, createdBy: getTestActorId() }))
			.returning()
		await db.insert(agentSkills).values([
			{ actorId: agent.id, workspaceSkillId: skill1.id },
			{ actorId: agent.id, workspaceSkillId: skill2.id },
		])
		await insertTrigger(db, ws.id, getTestActorId(), agent.id)

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.capability.overall.score).toBeGreaterThanOrEqual(40)
		expect(['practitioner', 'expert', 'master']).toContain(body.capability.overall.level)
		const skills = body.capability.dimensions.find((d: { key: string }) => d.key === 'skills')
		expect(skills?.score).toBeGreaterThanOrEqual(3)
		const autonomy = body.capability.dimensions.find((d: { key: string }) => d.key === 'autonomy')
		expect(autonomy?.score).toBeGreaterThanOrEqual(3)
	})

	it('caps Connectors at 2 and surfaces the missing integration when a placeholder is unresolved', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Slack Agent',
			systemPrompt: 'You are a bot.',
			tools: {
				mcpServers: {
					slack: {
						type: 'stdio',
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-slack'],
						env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' },
					},
				},
			},
		})
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: agent.id,
			role: 'member',
		})

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.capability.unresolvedPlaceholders).toContain('SLACK_BOT_TOKEN')
		const connectors = body.capability.dimensions.find(
			(d: { key: string }) => d.key === 'connectors',
		)
		expect(connectors?.score).toBeLessThanOrEqual(2)
		expect(
			body.capability.topGaps.some(
				(g: { toolHint?: string }) => g.toolHint === 'connect_integration',
			),
		).toBe(true)
	})

	it('resolves a placeholder once the matching integration is active in the workspace', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Slack Agent Connected',
			systemPrompt: 'You are a bot.',
			tools: {
				mcpServers: {
					slack: {
						type: 'stdio',
						command: 'npx',
						args: ['-y', '@modelcontextprotocol/server-slack'],
						env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' },
					},
				},
			},
		})
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: agent.id,
			role: 'member',
		})
		await db.insert(integrations).values(
			buildIntegration({
				workspaceId: ws.id,
				provider: 'slack',
				status: 'active',
				createdBy: getTestActorId(),
			}),
		)

		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(body.capability.unresolvedPlaceholders).not.toContain('SLACK_BOT_TOKEN')
	})
})

describe('Actors Integration — GET / list compact capability', () => {
	it('returns null compact capability for humans and the compact shape for agents', async () => {
		const app = createApp()
		const ws = await insertWorkspace(db, getTestActorId())
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'Agent In List',
			systemPrompt: 'You are a bot.',
		})
		await db.insert(workspaceMembers).values({
			workspaceId: ws.id,
			actorId: agent.id,
			role: 'member',
		})

		const res = await app.request(jsonGet('/api/actors', { 'X-Workspace-Id': ws.id }))
		expect(res.status).toBe(200)
		const body = await res.json()

		expect(Array.isArray(body)).toBe(true)
		const agentRow = body.find((r: { id: string }) => r.id === agent.id)
		const humanRow = body.find((r: { id: string }) => r.id === getTestActorId())

		expect(agentRow).toBeDefined()
		expect(agentRow.capability).toEqual({
			level: expect.any(String),
			score: expect.any(Number),
			topGapCount: expect.any(Number),
		})
		expect(agentRow.capability.level).toBe('novice')

		expect(humanRow).toBeDefined()
		expect(humanRow.capability).toBeNull()
	})
})

describe('Actors Integration — PATCH /:id capability is read-only', () => {
	it('drops capability from the PATCH body without touching the row', async () => {
		const app = createApp()
		const agent = await insertActor(db, {
			type: 'agent',
			name: 'PATCH Agent',
			systemPrompt: 'You are a bot.',
		})

		const patch = await app.request(`/api/actors/${agent.id}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				description: 'renamed',
				// Attempting to write a fabricated capability payload — the schema
				// should strip it silently rather than accept or 400.
				capability: {
					version: 1,
					overall: { score: 100, level: 'master' },
					dimensions: [],
					unresolvedPlaceholders: [],
					topGaps: [],
				},
			}),
		})
		expect(patch.status).toBe(200)

		// Re-fetch — capability should still be recomputed from the actor row,
		// not the value the client tried to POST.
		const res = await app.request(jsonGet(`/api/actors/${agent.id}`))
		const body = await res.json()
		expect(body.description).toBe('renamed')
		expect(body.capability.overall.level).toBe('novice')
	})
})
