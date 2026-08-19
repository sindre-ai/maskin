import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Locks the v2 readings of the object page against the mockup (1029–1502):
// the compact detail bar, the meta line above the title, the mono Activity
// rule with its segmented switch, the four timeline filter chips, the
// single-row composer, and the Related tab's grouped lists. Every assertion
// runs at all three ship-gate viewports, in both colour schemes for the
// surfaces that carry colour.

const TITLE = 'V2 surface probe'

test.describe('Object detail — v2 surface', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`reads as the v2 document at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
				content: 'Lead paragraph.\n\n## Bet\n\nA second section.',
			})
			const task = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: 'Linked task',
				status: 'todo',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'bet',
				source_id: bet.id,
				target_type: 'task',
				target_id: task.id,
				type: 'breaks_into',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 15000,
			})

			// The detail bar replaces the search + New cluster on this route.
			const bar = page.locator('main header').first()
			await expect(bar.getByRole('link', { name: 'Objects' })).toBeVisible()
			await expect(bar.getByText(TITLE)).toBeVisible()
			await expect(bar.getByRole('button', { name: /^New$/ })).toHaveCount(0)
			await expect(bar.getByRole('button', { name: 'Properties', exact: true })).toBeVisible()
			await expect(bar.getByRole('button', { name: /more actions/i })).toBeVisible()

			// Meta line above the title: type word, status chip, driver chip.
			await expect(page.getByText('Bet', { exact: true }).first()).toBeVisible()
			await expect(page.locator('[data-hero-status-trigger]')).toBeVisible()
			await expect(
				page
					.getByRole('combobox')
					.filter({ hasText: /driver/i })
					.first(),
			).toBeVisible()

			// Activity is a mono micro-heading on a rule, not a section title, and
			// the switch is a 2-way segmented control carrying the related count.
			await expect(page.getByText('Activity', { exact: true })).toBeVisible()
			await expect(page.getByRole('tab', { name: /^Timeline$/ })).toBeVisible()
			await expect(page.getByRole('tab', { name: /^Related 1$/ })).toBeVisible()

			// Four filter chips, in the mockup's order and vocabulary.
			for (const label of ['All', 'Comments', 'Decisions', 'Changes']) {
				await expect(page.getByRole('button', { name: new RegExp(`^${label} \\(`) })).toBeVisible()
			}

			// One-row composer with the mockup's placeholder and no hint line. The
			// phone gets the short form so the bar stays one line at 375px.
			await expect(
				page.getByPlaceholder(vp.width >= 768 ? 'Comment — / commands, @ mentions' : 'Comment…'),
			).toBeVisible()
			await expect(page.getByText(/is listening$/)).toHaveCount(0)

			// Related tab: a bordered list under its edge label, with the two
			// dashed add affordances beneath it.
			await page.getByRole('tab', { name: /^Related/ }).click()
			await expect(page.getByText('breaks into')).toBeVisible()
			await expect(page.getByRole('link', { name: 'Linked task' })).toBeVisible()
			await expect(page.getByRole('button', { name: /Link an object/ })).toBeVisible()
			await expect(page.getByRole('button', { name: /Upload a file/ })).toBeVisible()

			// No horizontal page scroll at this ship-gate viewport.
			const scrollWidth = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(scrollWidth).toBeLessThanOrEqual(0)
		})
	}

	// The bar, the status chip and the composer all read from colour tokens, so
	// they must stay legible in both schemes.
	for (const scheme of ['light', 'dark'] as const) {
		test(`detail bar and identity row hold up in ${scheme} mode`, async ({ page, account }) => {
			await page.setViewportSize({ width: 1024, height: 768 })
			await page.emulateMedia({ colorScheme: scheme })

			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
			})

			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
			await expect(page.getByRole('heading', { level: 1, name: TITLE })).toBeVisible({
				timeout: 15000,
			})

			const bar = page.locator('main header').first()
			await expect(bar.getByRole('link', { name: 'Objects' })).toBeVisible()
			await expect(bar.getByRole('button', { name: 'Properties', exact: true })).toBeVisible()
			await expect(page.locator('[data-hero-status-trigger]')).toBeVisible()
			await expect(page.getByPlaceholder('Comment — / commands, @ mentions')).toBeVisible()
		})
	}
})
