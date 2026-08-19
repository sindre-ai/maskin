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

			// The detail bar drops the workspace search but keeps the split New
			// button every screen carries, ordered ⋯ → properties → New.
			const bar = page.locator('main header').first()
			await expect(bar.getByRole('link', { name: 'Objects' })).toBeVisible()
			await expect(bar.getByText(TITLE)).toBeVisible()
			await expect(bar.getByRole('button', { name: /more actions/i })).toBeVisible()
			await expect(bar.getByRole('button', { name: 'Properties', exact: true })).toBeVisible()
			await expect(bar.getByRole('button', { name: /^New / })).toBeVisible()
			await expect(bar.getByRole('button', { name: /More ways to start/ })).toBeVisible()

			// Meta line above the title: type word, a Status pill and a Driver pill.
			await expect(page.getByText('Bet', { exact: true }).first()).toBeVisible()
			await expect(page.getByText('Status', { exact: true })).toBeVisible()
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

	// The v2 shell reads as a document, but it is still the place you fix an
	// object's title and body. Both were lost when the route moved off
	// ObjectDocument; this pins them to the shell.
	test('renames in place and edits the body, and both survive a reload', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Before rename',
			status: 'active',
			content: 'Original body.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		const heading = page.getByRole('heading', { level: 1 })
		await expect(heading).toHaveText('Before rename', { timeout: 15000 })

		// At rest the title is a real heading — the field only appears on click.
		await expect(page.getByLabel('Object title')).toHaveCount(0)
		await heading.click()
		const titleField = page.getByLabel('Object title')
		await expect(titleField).toBeVisible()
		await titleField.fill('After rename')
		await titleField.press('Enter')
		await expect(heading).toHaveText('After rename')

		// The body opens its editor on click, the same way it did pre-v2.
		await page.locator('.prose').first().click()
		const bodyField = page.locator('textarea').first()
		await bodyField.fill('Rewritten body.')
		await bodyField.blur()

		await page.reload()
		await expect(page.getByRole('heading', { level: 1 })).toHaveText('After rename', {
			timeout: 15000,
		})
		await expect(page.getByText('Rewritten body.')).toBeVisible()
	})

	// The body is a lightweight markdown surface: select text and a floating
	// B / I / <> toolbar edits the source in place (mockup 1030–1035).
	test('a selection in the body raises the formatting toolbar and applies it', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Formatting probe',
			status: 'active',
			content: 'Charges retry for three days.',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Formatting probe' })).toBeVisible({
			timeout: 15000,
		})

		// No toolbar until something is selected.
		await expect(page.getByRole('button', { name: 'Bold' })).toHaveCount(0)

		await page.locator('.prose p').first().evaluate((el) => {
			const range = document.createRange()
			const node = el.firstChild as Node
			range.setStart(node, 0)
			range.setEnd(node, 7)
			const selection = window.getSelection()
			selection?.removeAllRanges()
			selection?.addRange(range)
			el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
		})

		const bold = page.getByRole('button', { name: 'Bold' })
		await expect(bold).toBeVisible()
		await expect(page.getByRole('button', { name: 'Italic' })).toBeVisible()
		await expect(page.getByRole('button', { name: 'Code' })).toBeVisible()

		await bold.dispatchEvent('mousedown')
		await page.reload()
		await expect(page.getByRole('heading', { level: 1, name: 'Formatting probe' })).toBeVisible({
			timeout: 15000,
		})
		// The word came back bold, so the marker reached the stored markdown.
		await expect(page.locator('.prose strong')).toHaveText('Charges')
	})

	// "Reference an object" attaches removable chips that post as real
	// references on the timeline.
	test('the composer references an object and it lands on the timeline', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Reference probe',
			status: 'active',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: 'Referenced task',
			status: 'todo',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Reference probe' })).toBeVisible({
			timeout: 15000,
		})

		await page.getByRole('button', { name: /Add a file, object, or mention/i }).click()
		await page.getByRole('menuitem', { name: /Reference an object/i }).click()
		await page.getByPlaceholder('Search items…').fill('Referenced task')
		await page.getByRole('option').filter({ hasText: 'Referenced task' }).first().click()

		// A removable chip, not a pasted link.
		const chip = page.getByRole('button', { name: /Remove reference to Referenced task/ })
		await expect(chip).toBeVisible()

		await page.getByPlaceholder(/^Comment/).fill('Linking the task.')
		await page.getByRole('button', { name: /send comment/i }).click()

		await expect(chip).toHaveCount(0)
		await expect(page.getByText('Linking the task.')).toBeVisible()
		await expect(page.getByRole('link', { name: /Referenced task/ }).first()).toBeVisible()
	})

	// The drawer states who the object waits on and who made it.
	test('the properties drawer carries attention and the creator', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Drawer detail probe',
			status: 'active',
		})

		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByRole('heading', { level: 1, name: 'Drawer detail probe' })).toBeVisible(
			{ timeout: 15000 },
		)
		await page
			.locator('main header')
			.first()
			.getByRole('button', { name: 'Properties', exact: true })
			.click()

		await expect(page.getByText('created', { exact: true })).toBeVisible()
		// `<when> · <who>` — the creator rides the created row.
		await expect(page.getByText(/^E2E /).last()).toBeVisible()
		await expect(page.getByRole('button', { name: /Collapse properties/ })).toBeVisible()
	})

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
