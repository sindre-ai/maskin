import { describe, expect, it } from 'vitest'
import { modelRefusal } from '../../lib/agent-model-check'
import { CLAUDE_SUBSCRIPTION_MODEL, readFallbackConfig } from '../../lib/llm-routing'
import {
	DEFAULT_MODEL_TIER,
	FUNDED_DEFAULT_MODEL,
	MODEL_CATALOG,
	MODEL_TIERS,
	getCatalogModel,
	listRoutableModels,
	routeKindFor,
	tierModel,
} from '../../lib/model-catalog'

describe('model catalog', () => {
	it('has unique ids', () => {
		const ids = MODEL_CATALOG.map((m) => m.id)
		expect(new Set(ids).size).toBe(ids.length)
	})

	it('backs each tier with at most one entry per route kind', () => {
		for (const tier of MODEL_TIERS) {
			for (const route of ['subscription', 'openrouter'] as const) {
				expect(
					MODEL_CATALOG.filter((m) => m.tier === tier && m.route === route).length,
				).toBeLessThan(2)
			}
		}
	})

	it('carries the fields a reviewer needs on every entry', () => {
		for (const m of MODEL_CATALOG) {
			expect(m.displayName).not.toBe('')
			expect(m.dataHandling).not.toBe('')
			expect(m.priceSource).not.toBe('')
			expect(typeof m.toolUseProven).toBe('boolean')
			expect(m.smallFastModel).not.toBe('')
		}
	})

	it('points the default tier at what each route ran before the catalog existed', () => {
		expect(tierModel(DEFAULT_MODEL_TIER, 'subscription')?.id).toBe(CLAUDE_SUBSCRIPTION_MODEL)
		expect(tierModel(DEFAULT_MODEL_TIER, 'openrouter')?.id).toBe(FUNDED_DEFAULT_MODEL)
		expect(readFallbackConfig({}).model).toBe(FUNDED_DEFAULT_MODEL)
		expect(getCatalogModel(CLAUDE_SUBSCRIPTION_MODEL)?.effort).toBe('high')
		expect(getCatalogModel(FUNDED_DEFAULT_MODEL)).toMatchObject({
			effort: 'low',
			thinkingOff: true,
		})
	})

	it('never offers an enterprise workspace a funded-route model', () => {
		expect(routeKindFor(true)).toBe('subscription')
		expect(listRoutableModels(true).every((m) => m.route === 'subscription')).toBe(true)
		expect(listRoutableModels(false).every((m) => m.route === 'openrouter')).toBe(true)
	})
})

describe('modelRefusal', () => {
	it('accepts a catalog model on the route kind the workspace can reach', () => {
		expect(
			modelRefusal({ model: 'claude-opus-5-5', enterprise: true, honouredAsTyped: false }),
		).toBeNull()
		expect(
			modelRefusal({ model: FUNDED_DEFAULT_MODEL, enterprise: false, honouredAsTyped: false }),
		).toBeNull()
	})

	it('refuses a model that is not in the catalog and lists what would work', () => {
		const message = modelRefusal({ model: 'gpt-9', enterprise: false, honouredAsTyped: false })
		expect(message).toContain('"gpt-9" is not a model Maskin offers')
		expect(message).toContain(FUNDED_DEFAULT_MODEL)
	})

	it('refuses a funded-route model in an enterprise workspace', () => {
		const message = modelRefusal({
			model: FUNDED_DEFAULT_MODEL,
			enterprise: true,
			honouredAsTyped: false,
		})
		expect(message).toContain('enterprise workspaces do not use')
		expect(message).toContain('claude-sonnet-5-5')
	})

	it('refuses a Claude model in a workspace with no subscription route', () => {
		const message = modelRefusal({
			model: 'claude-sonnet-5-5',
			enterprise: false,
			honouredAsTyped: false,
		})
		expect(message).toContain('only enterprise workspaces have')
	})

	it('lets an enterprise own-key route pass the model as typed', () => {
		expect(
			modelRefusal({ model: 'anything-the-key-serves', enterprise: true, honouredAsTyped: true }),
		).toBeNull()
	})
})
