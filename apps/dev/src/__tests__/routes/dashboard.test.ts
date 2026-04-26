import { buildWorkspace } from '../factories'
import { jsonGet } from '../helpers'
import { createTestApp } from '../setup'

const chatMock = vi.fn()

vi.mock('../../lib/llm', () => ({
	createLLMAdapter: () => ({ chat: chatMock }),
}))

const { default: dashboardRoutes } = await import('../../routes/dashboard')
const { clearHeadlineCache } = await import('../../services/dashboard-headline')

const wsId = '00000000-0000-0000-0000-0000000000a1'

function workspaceWithLlmKey() {
	const ws = buildWorkspace({ id: wsId })
	const settings = ws.settings as Record<string, unknown>
	ws.settings = { ...settings, llm_keys: { anthropic: 'sk-ant-test' } }
	return ws
}

describe('GET /api/workspaces/:id/headline', () => {
	beforeEach(() => {
		clearHeadlineCache()
		chatMock.mockReset()
	})

	it('returns the LLM-generated headline on the happy path', async () => {
		const ws = workspaceWithLlmKey()
		chatMock.mockResolvedValue({
			content: 'Two agents are shipping the onboarding redesign; one needs your call on copy.',
			tool_calls: [],
			finish_reason: 'stop',
		})

		const { app, mockResults } = createTestApp(dashboardRoutes, '/api/workspaces')
		mockResults.selectQueue = [[ws], [], [], []]

		const res = await app.request(jsonGet(`/api/workspaces/${wsId}/headline`))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.source).toBe('llm')
		expect(body.headline).toBe(
			'Two agents are shipping the onboarding redesign; one needs your call on copy.',
		)
		expect(typeof body.generatedAt).toBe('string')
		expect(chatMock).toHaveBeenCalledTimes(1)
	})

	it('falls back to the rule-based sentence when the LLM call throws', async () => {
		const ws = workspaceWithLlmKey()
		chatMock.mockRejectedValue(new Error('Anthropic API error: 500 boom'))

		const { app, mockResults } = createTestApp(dashboardRoutes, '/api/workspaces')
		// Aggregate inputs: workspace, running sessions, pending notifications, events
		mockResults.selectQueue = [[ws], [{ id: 'sess-1' }], [], []]

		const res = await app.request(jsonGet(`/api/workspaces/${wsId}/headline`))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.source).toBe('fallback')
		expect(body.headline).toBe('1 agent is shipping work — nothing needs your call right now.')
	})

	it('rejects a non-UUID workspace id with 400', async () => {
		const { app } = createTestApp(dashboardRoutes, '/api/workspaces')

		const res = await app.request(jsonGet('/api/workspaces/not-a-uuid/headline'))

		expect(res.status).toBe(400)
	})

	it('returns 404 when the workspace is not found', async () => {
		const { app, mockResults } = createTestApp(dashboardRoutes, '/api/workspaces')
		mockResults.selectQueue = [[], [], [], []]

		const res = await app.request(jsonGet(`/api/workspaces/${wsId}/headline`))

		expect(res.status).toBe(404)
	})
})
