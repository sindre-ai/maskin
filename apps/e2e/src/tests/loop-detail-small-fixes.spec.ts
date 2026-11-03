import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Regression coverage for the four post-ship defects Sebastian flagged on the
// shipped loop detail page (loop-detail-implementation-review.md §10). Each test
// below pins one of the user-visible symptoms reported against the live page.

// A chart fence whose JSON never closes — this is what produced the raw
// "JSON Parse error: Unexpected EOF" the reader saw. The fence is parsed by
// parseChartSpec, which must turn this into a friendly reason instead.
const TRUNCATED_CHART_FENCE =
	'Here is the breakdown:\n\n```chart\n{"type":"bar","x":"step","series":["count"],"data":[{"step":"a","count":1\n```'

// An empty chart fence renders nothing (no error box) — the source is blank, so
// there is nothing to fail to parse.
const EMPTY_CHART_FENCE = 'Nothing to chart yet:\n\n```chart\n```'

test.describe('Loop detail — post-ship small defects', () => {
	test('breadcrumb leaf shows the loop name, not the static "Loop Details"', async ({
		page,
		account,
	}) => {
		// The breadcrumb is hidden below md (768px), so this surface only exists
		// at the tablet/desktop ship-gate viewports.
		for (const viewport of SHIP_GATE_VIEWPORTS.filter((v) => v.width >= 768)) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Renewal risk loop',
				status: 'learning',
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await expect(page.getByRole('heading', { name: 'Renewal risk loop' })).toBeVisible({
				timeout: 20000,
			})

			const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' })
			await expect(breadcrumb).toBeVisible()
			// The leaf crumb must name the loop itself.
			await expect(breadcrumb.getByText('Renewal risk loop')).toBeVisible()
			// The defect: the leaf fell back to the route's static label.
			await expect(page.getByText('Loop Details')).toHaveCount(0)
		}
	})

	test('chart fence with truncated JSON shows a friendly fallback, never the raw parse error', async ({
		page,
		account,
	}) => {
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Chart fallback loop',
			status: 'learning',
		})
		await account.api.createComment(account.workspaceId, {
			entity_id: loop.id,
			content: TRUNCATED_CHART_FENCE,
		})

		for (const viewport of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await expect(page.getByRole('heading', { name: 'Chart fallback loop' })).toBeVisible({
				timeout: 20000,
			})

			// AC: a real error state replaces the raw parser message. The rendered
			// copy uses a typographic apostrophe ("Couldn’t"), so the assertion
			// matches the apostrophe-free tail of the sentence instead.
			const note = page.getByRole('note').first()
			await expect(note).toBeVisible({ timeout: 10000 })
			await expect(note).toContainText('render chart')
			await expect(note).toContainText('incomplete or malformed')
			// The exact string the reader must never see again.
			await expect(page.getByText('Unexpected EOF')).toHaveCount(0)
		}
	})

	test('an empty chart fence renders nothing rather than an error box', async ({
		page,
		account,
	}) => {
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Empty chart loop',
			status: 'learning',
		})
		await account.api.createComment(account.workspaceId, {
			entity_id: loop.id,
			content: EMPTY_CHART_FENCE,
		})

		for (const viewport of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await expect(page.getByRole('heading', { name: 'Empty chart loop' })).toBeVisible({
				timeout: 20000,
			})

			// The comment is present…
			await expect(page.getByText('Nothing to chart yet:')).toBeVisible({ timeout: 10000 })
			// …but nothing about it renders as a chart error.
			await expect(page.getByRole('note')).toHaveCount(0)
		}
	})

	test('consecutive same-actor updates fold into one collapsed run that expands in place', async ({
		page,
		account,
	}) => {
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Folding loop',
			status: 'learning',
		})

		// Three routine updates from the same actor — the editor nudging the
		// loop body. These are the low-signal rows the fold is meant to collapse.
		for (const body of ['Draft one', 'Draft two', 'Draft three']) {
			await account.api.updateObject(loop.id, account.workspaceId, { content: body })
		}

		for (const viewport of SHIP_GATE_VIEWPORTS) {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			await expect(page.getByRole('heading', { name: 'Folding loop' })).toBeVisible({
				timeout: 20000,
			})

			// AC: the three consecutive updates collapse behind a single pill.
			const foldToggle = page.getByRole('button', { name: /\d+ agent updates/ })
			await expect(foldToggle).toBeVisible({ timeout: 10000 })
			await expect(foldToggle).toHaveAttribute('aria-expanded', 'false')
			await expect(foldToggle).toContainText('3 agent updates')

			// Expanding reveals the hidden rows and flips the label.
			await foldToggle.click()
			const expanded = page.getByRole('button', { name: /Hide \d+ updates/ })
			await expect(expanded).toHaveAttribute('aria-expanded', 'true')
			await expect(page.getByText('Draft three')).toBeVisible()
		}
	})
})
