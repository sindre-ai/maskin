import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// v16 Marketplace: catalogue entries are list rows grouped under a section
// header with a count, not a card grid. The dev bootstrap seeds bundle flows,
// so the Flows section always has rows to inspect.

test.describe('Marketplace rows (v16)', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`entries are full-width rows with a counted header at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/marketplace`)

			const flows = page.getByRole('region', { name: 'Flows' })
			await expect(flows).toBeVisible({ timeout: 20000 })
			const rows = flows.locator('article')
			const count = await rows.count()
			expect(count).toBeGreaterThanOrEqual(2)

			// The header reads the section name and its count.
			await expect(flows.getByRole('heading', { level: 2, name: 'Flows' })).toBeVisible()
			await expect(flows.getByText(String(count), { exact: true }).first()).toBeVisible()

			// One column: every row spans the same width and they stack.
			const first = await rows.nth(0).boundingBox()
			const second = await rows.nth(1).boundingBox()
			if (!first || !second) throw new Error('missing row boxes')
			expect(Math.abs(first.x - second.x)).toBeLessThanOrEqual(1)
			expect(Math.abs(first.width - second.width)).toBeLessThanOrEqual(1)
			expect(second.y).toBeGreaterThanOrEqual(first.y + first.height - 1)

			// The action is reachable: 44px tall on touch widths.
			const add = rows.nth(0).getByRole('button', { name: 'Add', exact: true })
			await expect(add).toBeVisible()
			const addBox = await add.boundingBox()
			if (!addBox) throw new Error('missing Add box')
			expect(addBox.height).toBeGreaterThanOrEqual(viewport.width < 1024 ? 44 : 28)
			expect(addBox.x + addBox.width).toBeLessThanOrEqual(viewport.width)

			// The page never scrolls sideways.
			const overflowPx = await page.evaluate(
				() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
			)
			expect(overflowPx).toBeLessThanOrEqual(1)
		})
	}

	test('flows are grouped by category, A to Z, inside the Flows region', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}/marketplace`)

		const flows = page.getByRole('region', { name: 'Flows' })
		await expect(flows).toBeVisible({ timeout: 20000 })
		const groups = flows.getByTestId('flow-group')
		const groupCount = await groups.count()
		expect(groupCount).toBeGreaterThanOrEqual(1)

		// Every flow row stays inside the Flows region, spread across the groups.
		const rowsInGroups = await groups.locator('article').count()
		expect(rowsInGroups).toBe(await flows.locator('article').count())

		// One group means no sub-headers; several mean one header per group, with
		// "Other" (flows without a category) last and the rest A to Z.
		const names = await groups.evaluateAll((els) =>
			els.map((el) => el.querySelector(':scope > div.pt-4 > span.font-bold')?.textContent ?? ''),
		)
		if (groupCount === 1) {
			expect(names[0]).toBe('')
		} else {
			const named = names.filter((n) => n !== 'Other')
			const sorted = [...named].sort((a, b) =>
				a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
			)
			expect(named).toEqual(sorted)
			if (names.includes('Other')) expect(names[names.length - 1]).toBe('Other')
		}
	})

	for (const scheme of ['light', 'dark'] as const) {
		test(`rows and their action read in ${scheme} mode`, async ({ page, account }) => {
			await page.emulateMedia({ colorScheme: scheme })
			await page.setViewportSize({ width: 1024, height: 768 })
			await page.goto(`/${account.workspaceId}/marketplace`)
			const row = page.getByRole('region', { name: 'Flows' }).locator('article').first()
			await expect(row).toBeVisible({ timeout: 20000 })
			await expect(row.getByRole('heading', { level: 3 })).toBeVisible()
			await expect(row.getByRole('button', { name: 'Add', exact: true })).toBeVisible()
		})
	}
})
