import type { OpenAPIHono } from '@hono/zod-openapi'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentBuilderRoutes from '../../routes/agent-builder'
import { jsonRequest } from '../helpers'
import { createMockAgentStorage, createTestContext } from '../setup'

vi.mock('../../services/agent-builder', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../services/agent-builder')>()
	return {
		...actual,
		runAgentBuilder: vi.fn(),
	}
})

const { runAgentBuilder: mockedRun } = await import('../../services/agent-builder')
const runAgentBuilder = mockedRun as unknown as ReturnType<typeof vi.fn>

const BASE = '/api/agent-builder'
const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111'

// The route needs agentStorage in context — createTestApp does not set it —
// so mount the route with a local harness that injects it here.
function createAgentBuilderTestApp() {
	const app = new CreateOpenAPIHono()
	const { db, mockResults } = createTestContext()
	const agentStorage = createMockAgentStorage()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', 'caller-actor-id')
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route(BASE, agentBuilderRoutes as unknown as OpenAPIHono)
	return { app, db, mockResults, agentStorage }
}

describe('POST /api/agent-builder/create', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		runAgentBuilder.mockReset()
	})

	it('returns 200 with actor + skill IDs on happy path (workspace_id via body)', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'created',
			intent: {
				domain: 'growth',
				job_to_be_done: 'plan a launch',
				deliverables: [],
				constraints: [],
				is_underspecified: false,
				missing: [],
				gap_question: '',
			},
			persona: {
				name: 'Test',
				role: 'Growth PM',
				backstory: 'story',
				scope_boundaries: [],
				delegation_description: 'use when',
				tool_set: [],
			},
			systemPrompt: {} as never,
			opinionation: {} as never,
			assembledSystemPrompt: '# Test\n\n## Background\n...',
			skillMd: '---\nname: test-abc\n---\n',
			skillName: 'test-abc',
			actor: { id: 'actor-1', name: 'Test', description: 'use when' },
			skill: { id: 'skill-1', name: 'test-abc' },
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help plan a B2B launch',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.actor_id).toBe('actor-1')
		expect(body.skill_id).toBe('skill-1')
		expect(body.persona.name).toBe('Test')
		expect(body.system_prompt).toMatch(/## Background/)
	})

	it('accepts workspace_id via X-Workspace-Id header', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'created',
			intent: { domain: 'x', job_to_be_done: 'y' } as never,
			persona: {} as never,
			systemPrompt: {} as never,
			opinionation: {} as never,
			assembledSystemPrompt: '',
			skillMd: '',
			skillName: 'test',
			actor: { id: 'a', name: 'A', description: '' },
			skill: { id: 's', name: 'test' },
		})

		const { app } = createAgentBuilderTestApp()
		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'X-Workspace-Id': WORKSPACE_ID,
			},
			body: JSON.stringify({ prompt: 'plan a launch' }),
		})
		const res = await app.request(req)
		expect(res.status).toBe(200)
	})

	it('returns 200 with gap_question when the pipeline short-circuits', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'gap_question',
			gap_question: 'What field and what outcome?',
			missing: ['domain', 'job_to_be_done'],
		})

		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help me',
				workspace_id: WORKSPACE_ID,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.gap_question).toMatch(/field and what outcome/)
		expect(body.missing).toEqual(['domain', 'job_to_be_done'])
	})

	it('returns 400 when body is missing prompt', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, { workspace_id: WORKSPACE_ID }),
		)
		expect(res.status).toBe(400)
	})

	it('returns 400 when body is not JSON', async () => {
		const { app } = createAgentBuilderTestApp()
		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-json',
		})
		const res = await app.request(req)
		expect(res.status).toBe(400)
	})

	it('returns 400 when workspace_id is missing from body AND header', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, { prompt: 'plan something' }),
		)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error?.message ?? body.message).toMatch(/workspace_id/i)
	})

	it('returns 400 when workspace_id is not a valid UUID', async () => {
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'plan something',
				workspace_id: 'not-a-uuid',
			}),
		)
		expect(res.status).toBe(400)
	})

	it('returns 500 when the pipeline throws AgentBuilderError', async () => {
		const { AgentBuilderError } = await import('../../services/agent-builder')
		runAgentBuilder.mockRejectedValue(new AgentBuilderError('llm_http_error', 'boom'))
		const { app } = createAgentBuilderTestApp()
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'anything',
				workspace_id: WORKSPACE_ID,
			}),
		)
		expect(res.status).toBe(500)
	})
})
