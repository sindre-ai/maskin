import type { BrowserContext, Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'

// D5 cross-device star sync. Two contexts (two "devices") authenticated as
// the same actor: ctx1 toggles the star on an object, ctx2 sees the flip
// within one refresh. The task path in the spec (apps/e2e/tests/objects/…)
// doesn't match playwright.config.ts's testDir (./src/tests) — this file
// carries the same coverage under the conventional flat-kebab name.
//
// Filed against apps/e2e/src/tests/ (playwright.config.ts testDir).

async function seedAuth(
	context: BrowserContext,
	auth: {
		apiKey: string
		actor: { id: string; name: string; type: string; email: string | null }
		workspaceId: string
	},
) {
	await context.addInitScript((data: typeof auth) => {
		localStorage.setItem('maskin-api-key', data.apiKey)
		localStorage.setItem('maskin-actor', JSON.stringify(data.actor))
		localStorage.setItem(`north_star_answered_${data.workspaceId}`, '1')
	}, auth)
}

async function findRowStar(page: Page, title: string) {
	// The row's title link renders the object title; the star button sits at
	// the row's leading edge. Scope to the row that carries the title so we
	// don't match a stale row from a prior seed.
	const row = page.locator('[data-obj-id]').filter({ hasText: title }).first()
	await expect(row).toBeVisible({ timeout: 15000 })
	// Either "Star this object" or "Starred (click to remove)" — whichever the
	// current state is. The caller asserts the aria-pressed value after.
	return row.getByRole('button', { name: /^(Star this object|Starred \(click to remove\))$/ })
}

test.describe('D5 star cross-device sync', () => {
	test('a toggle on one device is visible on another within one refresh', async ({
		account,
		browser,
	}) => {
		const object = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: `Star sync ${Date.now()}`,
			status: 'todo',
		})
		const authPayload = {
			apiKey: account.apiKey,
			actor: {
				id: account.actorId,
				name: 'E2E Actor',
				type: 'human',
				email: null,
			},
			workspaceId: account.workspaceId,
		}

		// Two independent browser contexts as the same actor — the shape the SPEC
		// calls out for "same actor, two devices". A shared cookie jar (single
		// context, two tabs) wouldn't cover the SSE + server-truth path we're
		// actually shipping.
		const ctx1 = await browser.newContext()
		const ctx2 = await browser.newContext()
		try {
			await seedAuth(ctx1, authPayload)
			await seedAuth(ctx2, authPayload)

			const page1 = await ctx1.newPage()
			const page2 = await ctx2.newPage()

			await page1.goto(`/${account.workspaceId}/objects`)
			await page2.goto(`/${account.workspaceId}/objects`)

			// Star on device 1.
			const star1 = await findRowStar(page1, object.title)
			await expect(star1).toHaveAttribute('aria-pressed', 'false')
			await star1.click()
			await expect(star1).toHaveAttribute('aria-pressed', 'true')

			// Device 2: reload — one refresh is the SPEC-mandated bound.
			await page2.reload()
			const star2 = await findRowStar(page2, object.title)
			await expect(star2).toHaveAttribute('aria-pressed', 'true')

			// And the reverse direction: unstar on device 2, refresh device 1, sees
			// the flip. Same one-refresh contract.
			await star2.click()
			await expect(star2).toHaveAttribute('aria-pressed', 'false')

			await page1.reload()
			const star1Again = await findRowStar(page1, object.title)
			await expect(star1Again).toHaveAttribute('aria-pressed', 'false')
		} finally {
			await ctx1.close()
			await ctx2.close()
		}
	})

	test('the star also renders on the detail meta row, left of the status chip', async ({
		page,
		account,
	}) => {
		const object = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: `Star detail ${Date.now()}`,
			status: 'todo',
		})

		await page.goto(`/${account.workspaceId}/objects/${object.id}`)
		await expect(page.getByRole('heading', { level: 1, name: object.title })).toBeVisible({
			timeout: 15000,
		})

		const star = page.getByRole('button', { name: /^Star this object$/ })
		await expect(star).toBeVisible()
		await expect(star).toHaveAttribute('aria-pressed', 'false')
		await star.click()

		const starredButton = page.getByRole('button', { name: /^Starred \(click to remove\)$/ })
		await expect(starredButton).toBeVisible()
		await expect(starredButton).toHaveAttribute('aria-pressed', 'true')
	})
})
