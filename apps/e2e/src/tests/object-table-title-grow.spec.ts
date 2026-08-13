import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

// Long titles must not be cut off while the row still has empty horizontal
// space. The surface covered is the /objects "list" view (which replaced
// the DataTable): rows are flex boxes — the title Link sits in a
// `flex-1 min-w-0` container with `min-w-0 truncate`, so it fills whatever
// width the fixed-size cells (checkbox, type, tag, updated, chevron) leave
// over.
//
// The old third test in this file targeted the DataTable-backed Related
// Objects table on the object detail page. That table was retired from the
// detail page in PR #823 (LinkedObjects moved to the create form only), so
// the surface no longer exists and the assertion can't run.
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
})
