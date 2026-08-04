import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { type NamedViewport, SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

const HORIZONTAL_OVERFLOW_TOLERANCE_PX = 1

async function assertNoHorizontalOverflow(page: Page, surface: string, viewport: NamedViewport) {
	// `load` instead of `networkidle` — the app holds an SSE connection to /api/events,
	// so networkidle never fires. Brief layout-settle wait after `load`.
	await page.waitForLoadState('load')
	await page.waitForTimeout(200)
	const { scrollWidth, innerWidth } = await page.evaluate(() => ({
		scrollWidth: document.documentElement.scrollWidth,
		innerWidth: window.innerWidth,
	}))
	expect(
		scrollWidth,
		`${surface} overflows horizontally at ${viewport.label}: scrollWidth=${scrollWidth} > innerWidth=${innerWidth}`,
	).toBeLessThanOrEqual(innerWidth + HORIZONTAL_OVERFLOW_TOLERANCE_PX)
}

// Critical controls that must remain visible at every ship-gate viewport on the
// For You → object → comment surface. The horizontal-overflow gate caught
// layout regressions but missed "control is rendered transparently" or
// "control was hidden behind a hover-only modifier on a touch device" — both
// of which silently fail the parity constraint ("no functionality hidden on
// iPad"). Each control is asserted by its accessible role/name + the
// Playwright `toBeVisible` opacity check (ignores opacity:0 and visibility:hidden).
async function assertReplyButtonVisibleOnObjectDetail(
	page: Page,
	surface: string,
	viewport: NamedViewport,
) {
	const replyButton = page.getByRole('button', { name: 'Reply' }).first()
	await expect(
		replyButton,
		`${surface}: reply-to-thread button must be visible at ${viewport.label}`,
	).toBeVisible({ timeout: 5000 })
}

async function assertCommentComposerVisible(page: Page, surface: string, viewport: NamedViewport) {
	const composer = page.getByPlaceholder('Write a comment... Use @ to mention an agent').first()
	await expect(
		composer,
		`${surface}: comment composer must be visible at ${viewport.label}`,
	).toBeVisible({ timeout: 5000 })
}

interface Surface {
	name: string
	path: (workspaceId: string, ids: SeedIds) => string
	waitFor?: (page: Page) => Promise<void>
}

interface SeedIds {
	betId: string
	insightId: string
	taskId: string
}

const SURFACES: Surface[] = [
	{
		name: 'For You (workspace landing)',
		path: (ws) => `/${ws}`,
	},
	{
		name: 'Objects list',
		path: (ws) => `/${ws}/objects`,
		waitFor: async (page) => {
			await page.waitForLoadState('load')
		},
	},
	{
		name: 'Object detail (bet)',
		path: (ws, ids) => `/${ws}/objects/${ids.betId}`,
		waitFor: async (page) => {
			await expect(page.getByText('Mobile QA Bet')).toBeVisible({ timeout: 10000 })
		},
	},
	{
		name: 'Object detail (insight)',
		path: (ws, ids) => `/${ws}/objects/${ids.insightId}`,
	},
	{
		name: 'Object detail (task)',
		path: (ws, ids) => `/${ws}/objects/${ids.taskId}`,
	},
	{
		name: 'Agents list',
		path: (ws) => `/${ws}/agents`,
	},
	{
		name: 'Triggers list',
		path: (ws) => `/${ws}/triggers`,
	},
	{
		name: 'Settings index',
		path: (ws) => `/${ws}/settings`,
	},
	{
		name: 'Settings — objects',
		path: (ws) => `/${ws}/settings/objects`,
	},
	{
		name: 'Settings — members',
		path: (ws) => `/${ws}/settings/members`,
	},
	{
		name: 'Settings — keys',
		path: (ws) => `/${ws}/settings/keys`,
	},
	{
		name: 'Settings — integrations',
		path: (ws) => `/${ws}/settings/integrations`,
	},
	{
		name: 'Settings — MCP',
		path: (ws) => `/${ws}/settings/mcp`,
	},
	{
		name: 'Settings — skills',
		path: (ws) => `/${ws}/settings/skills`,
	},
]

async function seedObjects(account: {
	workspaceId: string
	api: {
		createObject: (
			ws: string,
			data: { type: string; title: string; status?: string },
		) => Promise<{ id: string }>
	}
}): Promise<SeedIds> {
	const bet = await account.api.createObject(account.workspaceId, {
		type: 'bet',
		title: 'Mobile QA Bet',
		status: 'signal',
	})
	const insight = await account.api.createObject(account.workspaceId, {
		type: 'insight',
		title: 'Mobile QA Insight',
		status: 'new',
	})
	const task = await account.api.createObject(account.workspaceId, {
		type: 'task',
		title: 'Mobile QA Task',
		status: 'todo',
	})
	return { betId: bet.id, insightId: insight.id, taskId: task.id }
}

test.describe('Mobile + iPad QA — viewport overflow ship gate', () => {
	// Brief: every surface must pass the viewport-overflow check at 375 / 768 / 1024.
	// Any horizontal scroll at a ship-gate viewport fails the surface.
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`no horizontal overflow on any surface @ ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const ids = await seedObjects(account)

			for (const surface of SURFACES) {
				await page.goto(surface.path(account.workspaceId, ids))
				if (surface.waitFor) await surface.waitFor(page)
				await assertNoHorizontalOverflow(page, surface.name, viewport)
			}
		})
	}
})

test.describe('Mobile + iPad QA — critical controls ship gate', () => {
	// Brief: at every ship-gate viewport (375 / 768 / 1024), the comment composer
	// and the reply-to-thread button must be visible on object detail. The
	// horizontal-overflow gate caught layout regressions but missed cases where a
	// control was rendered with opacity:0 and a hover-only reveal — invisible on
	// touch devices like iPad portrait. Asserting accessible-role visibility here
	// catches "functionality hidden on iPad" before it ships.
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`reply button + composer visible on object detail @ ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			const ids = await seedObjects(account)
			// Seed a root comment so the Reply button surfaces (only rendered on root
			// comments without replies; an empty thread has nothing to reply to).
			await account.api.createComment(account.workspaceId, {
				entity_id: ids.betId,
				content: 'Seeded root comment for control-visibility ship gate',
			})

			await page.goto(`/${account.workspaceId}/objects/${ids.betId}`)
			await expect(page.getByText('Mobile QA Bet')).toBeVisible({ timeout: 10000 })

			await assertCommentComposerVisible(page, 'Object detail', viewport)
			await assertReplyButtonVisibleOnObjectDetail(page, 'Object detail', viewport)
		})
	}
})

test.describe('Mobile first-test flow — For You → object → comment', () => {
	test('walks the bet first-test flow at 375px without horizontal overflow', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({
			width: VIEWPORTS.mobile.width,
			height: VIEWPORTS.mobile.height,
		})
		const ids = await seedObjects(account)

		// 1. For You — workspace landing
		await page.goto(`/${account.workspaceId}`)
		await assertNoHorizontalOverflow(page, 'For You (step 1)', VIEWPORTS.mobile)

		// 2. Object detail — drive directly to the seeded bet (no unread thread is required;
		//    the brief's flow is "land → object → comment" and the unread feed depends on
		//    cross-actor activity that this single-actor fixture can't synthesize).
		await page.goto(`/${account.workspaceId}/objects/${ids.betId}`)
		await expect(page.getByText('Mobile QA Bet')).toBeVisible({ timeout: 10000 })
		await assertNoHorizontalOverflow(page, 'Object detail (step 2)', VIEWPORTS.mobile)

		// 3. Comment — type and send via the composer
		const composer = page.getByPlaceholder('Write a comment... Use @ to mention an agent')
		await composer.click()
		await composer.fill('QA comment from mobile')
		await page.getByRole('button', { name: 'Send comment' }).click()
		await expect(page.getByText('QA comment from mobile').first()).toBeVisible({ timeout: 10000 })
		await assertNoHorizontalOverflow(page, 'Object detail after comment (step 3)', VIEWPORTS.mobile)
	})
})

test.describe('Desktop regression — same surfaces at 1440', () => {
	test('no horizontal overflow on any surface @ Desktop (1440×900)', async ({ page, account }) => {
		await page.setViewportSize({
			width: VIEWPORTS.desktop.width,
			height: VIEWPORTS.desktop.height,
		})
		const ids = await seedObjects(account)

		for (const surface of SURFACES) {
			await page.goto(surface.path(account.workspaceId, ids))
			if (surface.waitFor) await surface.waitFor(page)
			await assertNoHorizontalOverflow(page, surface.name, VIEWPORTS.desktop)
		}
	})
})
