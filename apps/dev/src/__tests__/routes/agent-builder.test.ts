import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import agentBuilderRoutes from '../../routes/agent-builder'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const BASE = '/api/agent-builder'

function mockFetch(...jsonBodies: object[]) {
	const fetchMock = vi.fn()
	for (const body of jsonBodies) {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				choices: [{ message: { content: JSON.stringify(body) } }],
			}),
		})
	}
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const wellSpecifiedStage1 = {
	domain: 'SEO consulting',
	job_to_be_done: 'audit landing pages',
	deliverables: ['prioritised issue list'],
	constraints: [],
	is_underspecified: false,
	gap_question: '',
}

const wellSpecifiedStage2 = {
	name: 'Riley Okonkwo',
	role: 'Senior on-page SEO auditor',
	backstory:
		'Ten years auditing SaaS sites. Applies a crawl-first, semantics-second methodology. Biased toward measurable rankings gains; distrusts vanity metrics like Domain Authority.',
	scope_boundaries: ['does not advise on paid ads'],
	delegation_description:
		'Use this agent when a Series-A SaaS team needs an opinionated on-page SEO audit.',
	tool_set: ['read_url', 'search_web'],
}

describe('POST /api/agent-builder/create', () => {
	beforeEach(() => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'test-key'
		vi.spyOn(console, 'log').mockImplementation(() => undefined)
		vi.spyOn(console, 'warn').mockImplementation(() => undefined)
		vi.spyOn(console, 'error').mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllGlobals()
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = undefined
	})

	it('returns 200 with persona on well-specified prompt', async () => {
		const { app } = createTestApp(agentBuilderRoutes, BASE)
		mockFetch(wellSpecifiedStage1, wellSpecifiedStage2)

		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, {
				prompt: 'SEO auditor for early-stage SaaS landing pages, budget-conscious.',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.status).toBe('ok')
		expect(body.persona.name).toBe('Riley Okonkwo')
		expect(body.intent.domain).toBe('SEO consulting')
	})

	it('returns 200 with gap_question on underspecified prompt', async () => {
		const { app } = createTestApp(agentBuilderRoutes, BASE)
		const fetchMock = mockFetch({
			domain: '',
			job_to_be_done: '',
			deliverables: [],
			constraints: [],
			is_underspecified: true,
			gap_question: 'What field should this agent be an expert in, and what should it do?',
		})

		const res = await app.request(jsonRequest('POST', `${BASE}/create`, { prompt: 'help' }))

		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = await res.json()
		expect(body.status).toBe('underspecified')
		expect(body.gap_question).toBe(
			'What field should this agent be an expert in, and what should it do?',
		)
	})

	it('returns 400 on invalid body', async () => {
		const { app } = createTestApp(agentBuilderRoutes, BASE)

		const res = await app.request(jsonRequest('POST', `${BASE}/create`, { prompt: '' }))

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.code).toBe('VALIDATION_ERROR')
	})

	it('returns 503 when the LLM provider is not configured', async () => {
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = ''
		const { app } = createTestApp(agentBuilderRoutes, BASE)

		const res = await app.request(
			jsonRequest('POST', `${BASE}/create`, { prompt: 'SEO auditor for SaaS.' }),
		)

		expect(res.status).toBe(503)
	})
})
