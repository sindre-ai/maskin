import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// The Title column on the two object-page tables (the DataTable on /objects
// and the Related Objects table on a detail page) used to cap the title Link
// at max-w-[150px] sm:max-w-[300px], so long titles were cut off well before
// the row ran out of horizontal space. The fix marks the title TableHead
// with `w-full` (via header.column.id === 'title') and the title TableCell
// with `max-w-0`, so the auto-layout table hands the leftover width to that
// column and the flex child (min-w-0 flex-1 truncate) fills it and truncates
// cleanly. Both tables switch to a card layout below md via useIsMobile.
//
// Coverage is split in two:
// - Ship-gate viewports (375 / 768 / 1024) get smoke assertions: the page
//   renders and doesn't introduce a horizontal document scroll. The absolute
//   "title link > 300px" cap can't be asserted at these viewports without
//   modelling the layout — at 768 Chromium's scrollbar can drop innerWidth
//   below useIsMobile's 768 boundary (flipping to the card branch), and at
//   1024 the sidebar + chat panel are both open by default and eat enough
//   row width that the title cell ends up well below 300px even with the
//   fix applied.
// - Desktop viewports (1280 / 1440) get the DoD assertion: the title link
//   exceeds the previous 300px cap. This is what the bet's Definition of
//   Done actually asks for ("Verified on a normal desktop viewport with a
//   long-titled object").

const LONG_TITLE =
	'A very long object title that used to be cut off at three hundred pixels even when the row had plenty of empty horizontal space to the right of it'

const DESKTOP_VIEWPORTS = [VIEWPORTS.desktopXl, VIEWPORTS.desktop]

test.describe('Object table — Title column grows to fill available width', () => {
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

			// Anchored to the Bets tab — T5 flips the All-tab landing to a
			// non-tabular FleetStatusView; the title-column grow behavior
			// this spec covers is DataTable-only.
			await page.goto(`/${account.workspaceId}/objects?type=bet`)

			// The long-titled row must be reachable at every ship-gate viewport,
			// whether the DataTable renders as a table (≥ md) or a card (< md).
			const titleLink = page.getByRole('link', { name: LONG_TITLE })
			await expect(titleLink).toBeVisible({ timeout: 10000 })

			// The table's overflow-auto wrapper must contain any inner overflow,
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

			await page.goto(`/${account.workspaceId}/objects?type=bet`)
			const titleLink = page.getByRole('link', { name: LONG_TITLE })
			await expect(titleLink).toBeVisible({ timeout: 10000 })

			// The Title <th> carries w-full so auto-layout gives it all the leftover
			// width after the fixed-size columns.
			const titleHead = page.getByRole('columnheader', { name: /^title/i }).first()
			await expect(titleHead).toBeVisible()

			// The Link truncates via min-w-0 flex-1: its rendered width must be more
			// than the previous 300px cap (browser rounding tolerated).
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

	test('related objects table gives the title link more than the old 300px cap', async ({
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

		const titleLink = page.getByRole('link', { name: LONG_TITLE })
		await expect(titleLink).toBeVisible({ timeout: 10000 })

		const linkBox = await titleLink.boundingBox()
		if (!linkBox) throw new Error('related title link has no layout box')
		expect(linkBox.width).toBeGreaterThan(300)
	})
})
