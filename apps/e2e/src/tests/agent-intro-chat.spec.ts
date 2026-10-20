import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

/**
 * A new agent introduces itself in a 1-1 chat "Meet {name}" with the person who
 * created it, behind the agent-intro-1-1 flag (bet/e9ce-agent-intro-chat-routing,
 * slice 2). The flag is actor-scoped and read on the server, so this spec only
 * has something to assert when the stack under test lists the test actor in
 * FF_TESTER_ACTOR_IDS and the flag in FF_TESTER_FEATURES. CI does not set them,
 * so there the spec stays out of the way instead of failing.
 *
 * Not covered here: an agent reply to a message in the intro chat, and asking
 * Chief of Staff in the UI to create an agent. Both need a workspace with real
 * LLM credentials, which the e2e stack does not have.
 */

async function introFlagIsOn(page: Page, apiKey: string): Promise<boolean> {
	return page.evaluate(async (key) => {
		const res = await fetch('/api/feature-flags', { headers: { Authorization: `Bearer ${key}` } })
		if (!res.ok) return false
		const body = (await res.json()) as { flags?: Record<string, boolean> }
		return body.flags?.['agent-intro-1-1'] === true
	}, apiKey)
}

test.describe('Agent intro chat', () => {
	test('creating an agent in the UI puts an unread "Meet {name}" chat with its intro in the list', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/chats`)
		test.skip(
			!(await introFlagIsOn(page, account.apiKey)),
			'agent-intro-1-1 is not on for the test actor in this stack',
		)

		const name = `Intro Agent ${Date.now()}`
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await page.getByRole('menuitem', { name: /new agent/i }).click()
		await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill(name)
		await page.getByRole('dialog').getByLabel('Title', { exact: true }).press('Enter')
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents/`))

		// The intro lands within seconds of creation; the chat list refreshes on its own.
		await page.goto(`/${account.workspaceId}/chats`)
		const row = page.getByRole('link', { name: new RegExp(`Meet ${name}`) })
		await expect(row).toBeVisible({ timeout: 15_000 })
		await expect(row.getByLabel('1 unread')).toBeVisible()

		await row.click()
		await expect(page.getByRole('heading', { name: `Meet ${name}` })).toBeVisible()
		await expect(page.getByPlaceholder(`Reply to ${name}…`)).toBeVisible()
		// The chat list's snippet repeats the same text beside the thread, so take the first match.
		await expect(page.getByText(`I'm ${name}.`).first()).toBeVisible()
		await expect(page.getByText('Three ways to get me going:').first()).toBeVisible()
	})
})
