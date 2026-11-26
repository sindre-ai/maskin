import { afterEach, describe, expect, it, vi } from 'vitest'
import openaiAppsChallengeRoutes from '../../routes/openai-apps-challenge'

const PATH = '/.well-known/openai-apps-challenge'

describe('OpenAI apps domain proof', () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('serves exactly the configured token as plain text', async () => {
		vi.stubEnv('OPENAI_APPS_CHALLENGE', 'tok_abc123')
		const res = await openaiAppsChallengeRoutes.request(PATH)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toContain('text/plain')
		expect(await res.text()).toBe('tok_abc123')
	})

	it('trims whitespace around the token', async () => {
		vi.stubEnv('OPENAI_APPS_CHALLENGE', '  tok_abc123\n')
		expect(await (await openaiAppsChallengeRoutes.request(PATH)).text()).toBe('tok_abc123')
	})

	it.each([
		['unset', undefined],
		['empty', ''],
		['blank', '  '],
	])('answers 404 when the value is %s', async (_name, value) => {
		vi.stubEnv('OPENAI_APPS_CHALLENGE', value)
		const res = await openaiAppsChallengeRoutes.request(PATH)

		expect(res.status).toBe(404)
		expect(res.headers.get('content-type')).not.toContain('text/plain')
	})
})
