import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Item page layout: the title comes first, one meta line sits under it (star, type, status,
// owner), the text sits in a centred column of at most 720px, and the comment bar has a solid
// backing with the Comment / Message chip inside it.

const TITLE = 'Layout probe'

test.describe('Item page layout', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`title first, one meta line, 720px column @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
				content: 'A line of body text.\n\n'.repeat(40),
			})
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			const title = page.getByRole('heading', { level: 1, name: TITLE })
			await expect(title).toBeVisible({ timeout: 15000 })
			const star = page.getByRole('button', { name: 'Star this item' })
			const status = page.locator('[data-hero-status-trigger]')
			await expect(star).toBeVisible()
			await expect(status).toBeVisible()

			const titleBox = await title.boundingBox()
			const starBox = await star.boundingBox()
			const statusBox = await status.boundingBox()
			if (!titleBox || !starBox || !statusBox) throw new Error('missing box')

			// Title above the meta line; the star leads the line and its 14px glyph lines up with
			// the title's left edge (the button is 20px wide, so the glyph starts 3px in).
			expect(titleBox.y + titleBox.height).toBeLessThanOrEqual(starBox.y + starBox.height)
			expect(starBox.x).toBeLessThan(statusBox.x)
			expect(Math.abs(starBox.x + 3 - titleBox.x)).toBeLessThanOrEqual(2)

			// The column is never wider than 720px.
			const tabs = await page.getByRole('tablist', { name: 'Item sections' }).boundingBox()
			expect(tabs?.width ?? 0).toBeLessThanOrEqual(720)

			// Centred from tablet up: the same space on both sides of the column.
			if (vp.width >= 768) {
				const region = await page.locator('[data-detail-scroll-region]').boundingBox()
				if (!region || !tabs) throw new Error('missing box')
				const left = tabs.x - region.x
				const right = region.x + region.width - (tabs.x + tabs.width)
				expect(Math.abs(left - right)).toBeLessThanOrEqual(24)
			}

			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(0)
		})

		test(`comment bar has a backing and an in-bar mode chip @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor(`Chipper ${vp.label}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const bet = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: TITLE,
				status: 'active',
				driver: agent.id,
				content: 'A line of body text.\n\n'.repeat(80),
			})
			await page.goto(`/${account.workspaceId}/objects/${bet.id}`)

			const input = page.getByRole('textbox', { name: 'Comment' })
			await expect(input).toBeVisible({ timeout: 15000 })
			const chip = page.getByRole('button', { name: 'Switch between comment and message' })
			await expect(chip).toContainText('Comment')

			// The chip sits inside the bar, before the box.
			const chipBox = await chip.boundingBox()
			const inputBox = await input.boundingBox()
			if (!chipBox || !inputBox) throw new Error('missing box')
			expect(chipBox.x).toBeLessThan(inputBox.x)
			expect(
				Math.abs(chipBox.y + chipBox.height / 2 - (inputBox.y + inputBox.height / 2)),
			).toBeLessThan(24)

			// Solid backing with a fade, and scrolled to the middle the bar is still the top
			// element at its own centre (no body text over it).
			const band = page.locator('div.sticky.bottom-0').filter({ has: input })
			expect(await band.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
				'linear-gradient',
			)
			await page.locator('[data-detail-scroll-region]').evaluate((el) => {
				el.scrollTop = el.scrollHeight / 2
			})
			const covered = await input.evaluate((el) => {
				const r = el.getBoundingClientRect()
				const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
				return top !== null && (el === top || el.contains(top) || top.contains(el))
			})
			expect(covered).toBe(true)

			await chip.click()
			await expect(chip).toContainText('Message')
			await expect(page.getByRole('textbox', { name: 'Comment' })).toHaveCount(0)
			await chip.click()
			await expect(page.getByRole('textbox', { name: 'Comment' })).toBeVisible()
		})
	}

	test('no mode chip when the item has no agent to message', async ({ page, account }) => {
		const bet = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: TITLE,
			status: 'active',
		})
		await page.goto(`/${account.workspaceId}/objects/${bet.id}`)
		await expect(page.getByRole('textbox', { name: 'Comment' })).toBeVisible({ timeout: 15000 })
		await expect(
			page.getByRole('button', { name: 'Switch between comment and message' }),
		).toHaveCount(0)
	})
})
