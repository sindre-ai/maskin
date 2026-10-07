import { CHATS_V4_FLAGS, expect, test } from '../fixtures/auth.fixture'

test.describe('Auth fixture — Chats v4 flag overrides', () => {
	test('applies every override in the browser without a ReferenceError', async ({
		page,
		account,
	}) => {
		const pageErrors: string[] = []
		page.on('pageerror', (error) => pageErrors.push(error.message))

		await page.goto(`/${account.workspaceId}/chats`)

		const stored = await page.evaluate(
			(flags) => flags.map((flag) => localStorage.getItem(`ff:${flag}`)),
			CHATS_V4_FLAGS,
		)
		expect(stored).toEqual(CHATS_V4_FLAGS.map(() => 'on'))
		expect(pageErrors.filter((message) => message.includes('CHATS_V4_FLAGS'))).toEqual([])
	})
})
