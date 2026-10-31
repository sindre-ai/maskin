import { beforeEach, describe, expect, it, vi } from 'vitest'

const getModelPricing = vi.hoisted(() => vi.fn())
vi.mock('../../../lib/openrouter-pricing', () => ({ getModelPricing }))

const { lookupResearchModelPricing, researchRouteOf } = await import('../../../lib/research/model')

const PRICE = { prompt: 1e-6, completion: 5e-6, cacheRead: 0, cacheWrite: 0 }

describe('lookupResearchModelPricing', () => {
	beforeEach(() => getModelPricing.mockReset())

	it('uses the model id as given when the table has it', async () => {
		getModelPricing.mockImplementation(async (id: string) => (id === 'gpt-4o-mini' ? PRICE : null))
		expect(await lookupResearchModelPricing('gpt-4o-mini', 'openai')).toBe(PRICE)
		expect(getModelPricing).toHaveBeenCalledTimes(1)
	})

	it("finds an Anthropic API model id under OpenRouter's spelling", async () => {
		getModelPricing.mockImplementation(async (id: string) =>
			id === 'anthropic/claude-haiku-4.5' ? PRICE : null,
		)
		expect(await lookupResearchModelPricing('claude-haiku-4-5-20251001', 'anthropic')).toBe(PRICE)
	})

	it('returns null for a model with no price, so the run refuses to start', async () => {
		getModelPricing.mockResolvedValue(null)
		expect(await lookupResearchModelPricing('mystery-model', 'anthropic')).toBeNull()
	})

	it('does not guess a vendor prefix for an OpenAI-shaped model', async () => {
		getModelPricing.mockResolvedValue(null)
		await lookupResearchModelPricing('mystery-model', 'openai')
		expect(getModelPricing).toHaveBeenCalledTimes(1)
	})
})

describe('researchRouteOf', () => {
	const creds = (over: Record<string, unknown>) =>
		({ provider: 'openai', apiKey: 'k', model: 'm', ...over }) as never

	it('names the route the credentials came from, in the words sessions use', () => {
		expect(researchRouteOf(creds({ provider: 'anthropic' }), {})).toBe('workspace_api_key')
		expect(
			researchRouteOf(creds({ baseUrl: 'https://llm.example.com/v1' }), {
				custom_llm: { enabled: true },
			} as never),
		).toBe('workspace_custom')
		expect(researchRouteOf(creds({ baseUrl: 'https://openrouter.ai/api/v1' }), {})).toBe(
			'maskin_plan',
		)
	})
})
