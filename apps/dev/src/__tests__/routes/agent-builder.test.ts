import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentBuilderRoutes from '../../routes/agent-builder'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

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

	it('returns 200 with a persona on happy path', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'persona',
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
		})

		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'help plan a B2B launch',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.persona.name).toBe('Test')
		expect(body.intent.domain).toBe('growth')
	})

	it('returns 200 with gap_question when the pipeline short-circuits', async () => {
		runAgentBuilder.mockResolvedValue({
			kind: 'gap_question',
			gap_question: 'What field and what outcome?',
			missing: ['domain', 'job_to_be_done'],
		})

		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const res = await app.request(jsonRequest('POST', `${BASE}/create`, { prompt: 'help me' }))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.gap_question).toMatch(/field and what outcome/)
		expect(body.missing).toEqual(['domain', 'job_to_be_done'])
	})

	it('returns 400 when body is missing prompt', async () => {
		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const res = await app.request(jsonRequest('POST', `${BASE}/create`, {}))
		expect(res.status).toBe(400)
	})

	it('returns 400 when body is not JSON', async () => {
		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const req = new Request(`http://localhost${BASE}/create`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not-json',
		})
		const res = await app.request(req)
		expect(res.status).toBe(400)
	})

	it('returns 500 when the pipeline throws AgentBuilderError', async () => {
		const { AgentBuilderError } = await import('../../services/agent-builder')
		runAgentBuilder.mockRejectedValue(new AgentBuilderError('llm_http_error', 'boom'))
		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const res = await app.request(jsonRequest('POST', `${BASE}/create`, { prompt: 'anything' }))
		expect(res.status).toBe(500)
	})
})
