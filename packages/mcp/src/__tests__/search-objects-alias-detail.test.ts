import { describe, expect, it } from 'vitest'
import { tools } from '../tools'

// search_objects is a listed alias of list_objects and runs the same handler, which already
// supports detail: 'concise'. The alias schema lacked the key, so zod stripped it and every
// search came back as full rows (content included): in a 14-day PostHog sample, 1 of 2,908
// search_objects calls had a detail key, and their median response was about 49 KB.
describe('search_objects alias schema', () => {
	it('keeps detail so a caller can ask for concise rows', () => {
		const parsed = tools.search_objects.inputSchema.safeParse({ q: 'handbook', detail: 'concise' })
		expect(parsed.success).toBe(true)
		if (parsed.success) expect(parsed.data.detail).toBe('concise')
	})

	it('rejects a detail value that is not concise or full', () => {
		expect(tools.search_objects.inputSchema.safeParse({ q: 'x', detail: 'tiny' }).success).toBe(
			false,
		)
	})
})
