import { argosScreenshot } from '@argos-ci/playwright'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T4 reconcile banner. Simulates a 409 on the object detail page's autosave
// PATCH by intercepting the request; asserts the banner + three actions render
// and each action leaves the editor in a well-defined state.
//
// The 409 body carries the fresh server state (`{ object: ObjectResponse }`)
// per T2's contract — this test uses that shape without depending on the T2
// backend being merged.

async function setTheme(page: import('@playwright/test').Page, theme: 'light' | 'dark') {
	await page.addInitScript((t) => localStorage.setItem('maskin-theme', t), theme)
}

async function seedObject(
	api: import('../helpers/api.helper').TestAPI,
	workspaceId: string,
	title: string,
) {
	return api.createObject(workspaceId, {
		type: 'bet',
		title,
		status: 'active',
		content: 'Original body from the server.\n\nSecond paragraph.',
	})
}

interface StubOptions {
	body?: string
	version?: number
	// If true, only the first PATCH returns 409 — the retry succeeds.
	oneShot?: boolean
}

async function stub409(page: import('@playwright/test').Page, objectId: string, opts: StubOptions) {
	const theirsBody = opts.body ?? 'Their agent already saved this text.'
	const freshVersion = opts.version ?? 42
	let hits = 0
	await page.route(`**/api/objects/${objectId}`, async (route, request) => {
		if (request.method() !== 'PATCH') {
			return route.fallback()
		}
		hits += 1
		if (opts.oneShot && hits > 1) {
			return route.fallback()
		}
		await route.fulfill({
			status: 409,
			contentType: 'application/json',
			body: JSON.stringify({
				error: { code: 'CONFLICT', message: 'Version stale' },
				object: {
					id: objectId,
					workspaceId: 'ws',
					type: 'bet',
					title: 'Conflict target',
					content: theirsBody,
					status: 'active',
					metadata: null,
					driver: null,
					activeSessionId: null,
					createdBy: 'a1',
					createdAt: null,
					updatedAt: null,
					version: freshVersion,
				},
			}),
		})
	})
}

async function makeDirtyEdit(page: import('@playwright/test').Page, newText: string) {
	// MarkdownContent enters edit mode on click and mounts the TipTap editor.
	// Driving the contenteditable directly — `.fill()` doesn't work on a
	// ProseMirror surface. Blur flushes the pending debounced autosave, which
	// is the PATCH the 409 stub intercepts.
	const prose = page.locator('.prose').first()
	await prose.click()
	const editor = page.locator('[data-testid="tiptap-editor-mount"] .ProseMirror')
	await expect(editor).toBeVisible()
	await editor.click()
	await page.keyboard.press('ControlOrMeta+A')
	await page.keyboard.press('Delete')
	await page.keyboard.type(newText)
	await page.locator('body').click({ position: { x: 5, y: 5 } })
}

test.describe('Reconcile banner — 409 conflict UX', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`banner + three actions render at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const obj = await seedObject(account.api, account.workspaceId, `Reconcile ${vp.label}`)
			await stub409(page, obj.id, {})

			await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
			await expect(
				page.getByRole('textbox', { name: /untitled/i }).or(page.locator('h1')),
			).toBeVisible({
				timeout: 10000,
			})
			await makeDirtyEdit(page, 'My local unsaved edit that lost the race.')

			const banner = page.getByRole('alert')
			await expect(banner).toBeVisible()
			await expect(banner).toContainText(/content changed underneath you/i)
			await expect(banner.getByRole('button', { name: /review/i })).toBeVisible()
			await expect(banner.getByRole('button', { name: /keep mine/i })).toBeVisible()
			await expect(banner.getByRole('button', { name: /take theirs/i })).toBeVisible()
		})
	}

	test('Review opens the diff overlay with both sides visible', async ({ page, account }) => {
		const obj = await seedObject(account.api, account.workspaceId, 'Review conflict')
		await stub409(page, obj.id, { body: 'Their agent already saved this text.' })

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'My local edit for review.')

		const banner = page.getByRole('alert')
		await banner.getByRole('button', { name: /review/i }).click()

		await expect(page.getByRole('dialog', { name: /review conflict/i })).toBeVisible()
		await expect(page.getByText(/mine \(unsaved\)/i)).toBeVisible()
		await expect(page.getByText(/theirs \(server\)/i)).toBeVisible()
	})

	test('Keep mine retries with the fresh version and clears the banner', async ({
		page,
		account,
	}) => {
		const obj = await seedObject(account.api, account.workspaceId, 'Keep mine')
		await stub409(page, obj.id, { oneShot: true })

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'The version I insist on keeping.')

		const banner = page.getByRole('alert')
		await expect(banner).toBeVisible()
		await banner.getByRole('button', { name: /keep mine/i }).click()

		await expect(banner).toBeHidden()
	})

	test('Take theirs requires confirm; confirm replaces the editor with theirs', async ({
		page,
		account,
	}) => {
		const obj = await seedObject(account.api, account.workspaceId, 'Take theirs')
		await stub409(page, obj.id, { body: 'Server-authoritative body after take theirs.' })

		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'This will be discarded.')

		const banner = page.getByRole('alert')
		await banner.getByRole('button', { name: /take theirs/i }).click()
		// Confirm dialog is destructive; requires an explicit confirm.
		const confirm = page.getByRole('dialog', { name: /discard your edits/i })
		await expect(confirm).toBeVisible()
		await confirm.getByRole('button', { name: /discard and take theirs/i }).click()

		await expect(banner).toBeHidden()
		await expect(page.getByText('Server-authoritative body after take theirs.')).toBeVisible()
	})

	test('Argos — banner (light)', async ({ page, account }) => {
		await setTheme(page, 'light')
		const obj = await seedObject(account.api, account.workspaceId, 'Argos light')
		await stub409(page, obj.id, {})
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'Local dirty edit for snapshot.')
		await expect(page.getByRole('alert')).toBeVisible()
		await argosScreenshot(page, 'reconcile-banner-light')
	})

	test('Argos — banner (dark)', async ({ page, account }) => {
		await setTheme(page, 'dark')
		const obj = await seedObject(account.api, account.workspaceId, 'Argos dark')
		await stub409(page, obj.id, {})
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'Local dirty edit for dark snapshot.')
		await expect(page.getByRole('alert')).toBeVisible()
		await argosScreenshot(page, 'reconcile-banner-dark')
	})

	test('Argos — diff overlay (light)', async ({ page, account }) => {
		await setTheme(page, 'light')
		const obj = await seedObject(account.api, account.workspaceId, 'Argos overlay light')
		await stub409(page, obj.id, { body: 'Server body\nSecond server line.' })
		await page.goto(`/${account.workspaceId}/objects/${obj.id}`)
		await makeDirtyEdit(page, 'Mine body\nSecond mine line.')
		await page
			.getByRole('alert')
			.getByRole('button', { name: /review/i })
			.click()
		await expect(page.getByRole('dialog', { name: /review conflict/i })).toBeVisible()
		await argosScreenshot(page, 'reconcile-diff-overlay-light')
	})
})
