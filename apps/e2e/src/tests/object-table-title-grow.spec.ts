import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Long titles must not be cut off while the row still has empty horizontal
// space. Two surfaces are covered:
// - The /objects "list" surface (the List view that replaced the DataTable):
//   rows are flex boxes — the title Link sits in a `flex-1 min-w-0` container
//   with `min-w-0 truncate`, so it fills whatever width the fixed-size cells
//   (checkbox, type, tag, updated, chevron) leave over.
// - The Related Objects table on a detail page (still a DataTable): its title
//   TableHead carries `w-full` (via header.column.id === 'title') and the cell
//   `max-w-0`, so auto-layout hands all leftover width to that column.
//
// Coverage is split in two:
// - Ship-gate viewports (375 / 768 / 1024) get smoke assertions: the page
//   renders and doesn't introduce a horizontal document scroll. The absolute
//   "title link > 300px" cap can't be asserted at these viewports without
//   modelling the layout — at 768 Chromium's scrollbar can drop innerWidth
//   below useIsMobile's 768 boundary, and at 1024 the sidebar + chat panel are
//   both open by default and eat enough row width that the title falls well
//   below 300px even with the fix applied.
// - Desktop viewports (1280 / 1440) get the DoD assertion: the title link
//   exceeds the previous 300px cap. This is what the bet's Definition of
//   Done actually asks for ("Verified on a normal desktop viewport with a
//   long-titled object").

const LONG_TITLE =
	'A very long object title that used to be cut off at three hundred pixels even when the row had plenty of empty horizontal space to the right of it'

const DESKTOP_VIEWPORTS = [VIEWPORTS.desktopXl, VIEWPORTS.desktop]

test.describe('Object title — long titles fill available row width', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`objects list renders without horizontal page scroll at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: LONG_TITLE,
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)

			// The long-titled row must be reachable at every ship-gate viewport.
			const titleLink = page.getByRole('link', { name: LONG_TITLE })
			await expect(titleLink).toBeVisible({ timeout: 10000 })

			// The list's overflow-auto wrapper must contain any inner overflow,
			// not push the document itself sideways.
			const horizScroll = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(horizScroll, `document must not horizontally scroll at ${viewport.label}`).toBe(false)
		})
	}

	for (const viewport of DESKTOP_VIEWPORTS) {
		test(`objects list title fills leftover width at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: LONG_TITLE,
				status: 'signal',
			})

			await page.goto(`/${account.workspaceId}/objects`)
			const titleLink = page.getByRole('link', { name: LONG_TITLE })
			await expect(titleLink).toBeVisible({ timeout: 10000 })

			// The list row is a flex box: the Link lives in a flex-1 min-w-0
			// container, so it truncates only at the row's actual edge — its
			// rendered width must be more than the previous 300px cap (browser
			// rounding tolerated).
			const linkBox = await titleLink.boundingBox()
			if (!linkBox) throw new Error('title link has no layout box')
			expect(
				linkBox.width,
				`title link must exceed the old 300px cap at ${viewport.label}`,
			).toBeGreaterThan(300)

			const horizScroll = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			)
			expect(horizScroll, `document must not horizontally scroll at ${viewport.label}`).toBe(false)
		})
	}

	test('related objects table title fills leftover width on the detail surface', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: VIEWPORTS.desktop.width, height: VIEWPORTS.desktop.height })

		const parent = await account.api.createObject(account.workspaceId, {
			type: 'bet',
			title: 'Parent bet with a related row',
			status: 'signal',
		})
		const related = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: LONG_TITLE,
			status: 'todo',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: parent.id,
			target_type: 'object',
			target_id: related.id,
			type: 'relates_to',
		})

		await page.goto(`/${account.workspaceId}/objects/${parent.id}`)
		await expect(
			page.getByRole('heading', { level: 1, name: 'Parent bet with a related row' }),
		).toBeVisible({ timeout: 10000 })

		// T5 assembled the Related tab into the shell — the related row lives
		// there. Click into it before asserting the title-grow shape.
		await page.getByRole('tab', { name: /^Related/ }).click()

		const titleLink = page.getByRole('link', { name: LONG_TITLE })
		await expect(titleLink).toBeVisible({ timeout: 10000 })

		// The Related Objects table is still a DataTable: its Title <th> carries
		// w-full so auto-layout gives it all the leftover width.
		const titleHead = page.getByRole('columnheader', { name: /^title/i }).first()
		await expect(titleHead).toBeVisible()

		const linkBox = await titleLink.boundingBox()
		if (!linkBox) throw new Error('title link has no layout box')
		expect(linkBox.width).toBeGreaterThan(300)

		const horizScroll = await page.evaluate(
			() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
		)
		expect(horizScroll).toBe(false)
	})
})
