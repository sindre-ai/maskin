import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// The plan snapshot `/loops/new` writes to `metadata.plan`. Only loops that
// carry one can read an utterance back as a diff; the rest fall through to the
// chat hand-off (covered in loop-detail.spec.ts).
const STORED_PLAN = JSON.stringify({
	objectTypes: [
		{
			type: 'feedback',
			name: 'Feedback',
			role: 'Submissions from customers',
			live: false,
			stateChain: ['new', 'triage', 'approved', 'published'],
			isNew: false,
		},
	],
	triggers: [
		{
			kindLabel: 'EVENT',
			whenClause: 'when a customer submits feedback',
			targetAgent: 'Feedback agent',
			thenWrites: [{ act: 'state_change', type: 'feedback', state: 'triage' }],
			isNew: true,
			whenChip: { type: 'feedback', state: 'triage' },
		},
	],
	agents: [{ avatar: 'FA', name: 'Feedback agent', role: 'triages feedback', count: 1 }],
	stopForOperator: null,
})

const UTTERANCE =
	'when a customer submits feedback, have the Feedback agent triage it and ask me before publishing'

test.describe('Loop detail — PROPOSED EDIT', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`reads the change back before anything moves at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Feedback loop',
				status: 'running',
				metadata: { plan: STORED_PLAN },
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			const composer = page.getByPlaceholder('Listening — speak in plain words')
			await expect(composer).toBeVisible({ timeout: 10000 })

			await composer.fill(UTTERANCE)
			await composer.press('Enter')

			// Nothing navigates: the change is read back in place.
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops/${loop.id}`))
			await expect(page.getByText('PROPOSED EDIT')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('never')).toHaveCSS('text-decoration-line', 'line-through')
			await expect(page.getByText('before publishing')).toBeVisible()

			// The human-in-the-loop promise must be readable on a phone, not just
			// on a desktop-width row.
			await expect(page.getByText('nothing moves until you say so')).toBeVisible()

			// Both tinted surfaces read in either colour mode.
			await page.emulateMedia({ colorScheme: 'light' })
			await expect(page.getByText('PROPOSED EDIT')).toBeVisible()
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(page.getByText('PROPOSED EDIT')).toBeVisible()
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}

	test('"Leave it" dismisses without changing the loop', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Feedback loop',
			status: 'running',
			metadata: { plan: STORED_PLAN },
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		const composer = page.getByPlaceholder('Listening — speak in plain words')
		await expect(composer).toBeVisible({ timeout: 10000 })
		await composer.fill(UTTERANCE)
		await composer.press('Enter')
		await expect(page.getByText('PROPOSED EDIT')).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'Leave it' }).click()
		await expect(page.getByText('PROPOSED EDIT')).toBeHidden()

		// The stored plan is untouched — saying it again re-proposes the same diff.
		await page.reload()
		const composerAfter = page.getByPlaceholder('Listening — speak in plain words')
		await expect(composerAfter).toBeVisible({ timeout: 10000 })
		await composerAfter.fill(UTTERANCE)
		await composerAfter.press('Enter')
		await expect(page.getByText('PROPOSED EDIT')).toBeVisible({ timeout: 10000 })
	})

	test('"Make the change" persists across a reload', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Feedback loop',
			status: 'running',
			metadata: { plan: STORED_PLAN },
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		const composer = page.getByPlaceholder('Listening — speak in plain words')
		await expect(composer).toBeVisible({ timeout: 10000 })
		await composer.fill(UTTERANCE)
		await composer.press('Enter')
		await expect(page.getByText('PROPOSED EDIT')).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'Make the change' }).click()
		await expect(page.getByText('PROPOSED EDIT')).toBeHidden({ timeout: 10000 })

		// After a reload the stored plan already matches, so the same sentence
		// yields no diff — the change stuck.
		await page.reload()
		const composerAfter = page.getByPlaceholder('Listening — speak in plain words')
		await expect(composerAfter).toBeVisible({ timeout: 10000 })
		await composerAfter.fill(UTTERANCE)
		await composerAfter.press('Enter')
		await expect(page).toHaveURL(/chats\/new/, { timeout: 10000 })
	})
})
