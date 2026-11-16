import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The top bar and the bottom composer float over the page instead of boxing it in.
 *
 * Neither draws a background: content scrolls up under it and shows through, and the strip
 * lets clicks pass except on its own controls. At rest nothing sits under either, and
 * a thread stays pinned above its composer. The item page's comment bar is the exception: it
 * has a solid backing with a short fade, so body text never shows behind it.
 */

type Account = {
	workspaceId: string
	actorId: string
	api: import('../helpers/api.helper').TestAPI
}

async function seedLongFlow(account: Account, title: string) {
	const agent = await account.api.createAgentActor('Researcher')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const triggerIds: string[] = []
	for (let i = 1; i <= 6; i++) {
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: `Step ${i}`,
			type: 'event',
			action_prompt: `Do step ${i}`,
			target_actor_id: agent.id,
			config: { entity_type: 'task', action: 'created' },
		})
		triggerIds.push(trigger.id)
	}
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title,
		status: 'learning',
	})
	await account.api.updateObject(loop.id, account.workspaceId, {
		metadata: {
			trigger_ids: triggerIds,
			targets: [
				{ label: 'Pages in the top 10', source: 'metric:seo.top10', actual: 27, target: 40 },
				{ label: 'Terms in the top 20', source: 'metric:seo.top20', actual: 4, target: 10 },
				{ label: 'Customers closed', source: 'metric:sales.closed', actual: 0, target: 10 },
			],
		},
	})
	return loop
}

const overflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

for (const scheme of ['light', 'dark'] as const) {
	test.describe(`Floating bar and composer — flow page (${scheme})`, () => {
		for (const vp of SHIP_GATE_VIEWPORTS) {
			test(`content scrolls under the bar and its controls stay clickable @ ${vp.label}`, async ({
				page,
				account,
			}) => {
				await page.addInitScript((value) => localStorage.setItem('maskin-theme', value), scheme)
				await page.setViewportSize({ width: vp.width, height: vp.height })
				const loop = await seedLongFlow(account, `Floating ${scheme} ${vp.label}`)
				await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

				const title = page.getByRole('heading', { name: `Floating ${scheme} ${vp.label}` })
				await expect(title).toBeVisible({ timeout: 15_000 })
				const bar = page.locator('main > header').first()
				const newChat = bar.getByRole('button', { name: /New chat/ }).first()
				await expect(newChat).toBeVisible()

				// The bar is a solid, readable strip (no gradient, no blur) and lets clicks through apart from its controls.
				const barStyle = await bar.evaluate((el) => {
					const s = getComputedStyle(el)
					return {
						image: s.backgroundImage,
						color: s.backgroundColor,
						events: s.pointerEvents,
						position: s.position,
					}
				})
				expect(barStyle.position).toBe('absolute')
				expect(barStyle.image).toBe('none')
				expect(barStyle.color).not.toBe('rgba(0, 0, 0, 0)')
				expect(barStyle.events).toBe('none')

				// At rest the first row sits clear of the bar.
				const barBox = await bar.boundingBox()
				const titleBox = await title.boundingBox()
				expect(titleBox?.y ?? 0).toBeGreaterThanOrEqual(
					(barBox?.y ?? 0) + (barBox?.height ?? 0) - 1,
				)

				// The long pipeline lives on Setup now, so scroll there.
				await page.getByRole('tab', { name: 'Setup' }).click()
				// Scrolled, the tab row runs up under the bar: it takes the room the bar no longer holds.
				await page.locator('[data-scroll-root]').evaluate((el) => el.scrollTo(0, 400))
				const tabsBox = await page.getByRole('tab', { name: 'Overview' }).boundingBox()
				const barAfter = await bar.boundingBox()
				expect(tabsBox?.y ?? 1e9).toBeLessThan((barAfter?.y ?? 0) + (barAfter?.height ?? 0))

				// The control on top of it still takes the click.
				await expect(newChat).toBeVisible()
				await newChat.click({ trial: true })

				// The composer band has no background at all: the pill takes input, the band does not.
				const band = page.locator('div.sticky.bottom-0').filter({
					has: page.getByPlaceholder(/Say what should change|Message .+, who drives/),
				})
				const bandStyle = await band.evaluate((el) => {
					const s = getComputedStyle(el)
					return { image: s.backgroundImage, color: s.backgroundColor, events: s.pointerEvents }
				})
				expect(bandStyle.image).toBe('none')
				expect(bandStyle.color).toBe('rgba(0, 0, 0, 0)')
				expect(bandStyle.events).toBe('none')
				const input = page.getByPlaceholder(/Say what should change|Message .+, who drives/)
				await input.click({ trial: true })

				expect(await overflow(page)).toBeLessThanOrEqual(0)
			})
		}
	})
}

test.describe('Floating bar and composer — chat thread', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the thread fills the column and ends above the composer @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Floating QA Agent')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Floating thread ${vp.label}`,
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			for (let i = 1; i <= 14; i++) {
				await account.api.postConversationMessage(conversation.id, account.workspaceId, {
					content: `Message ${i}: words that wrap across the transcript so the thread gets long enough to scroll.`,
				})
			}
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const composer = page.getByLabel('Message this conversation').first()
			await expect(composer).toBeVisible({ timeout: 15_000 })
			const last = page.getByTestId('thread-messages').getByText('Message 14:').first()
			await expect(last).toBeVisible()

			// Pinned to the bottom, with the last message clear of the composer, not under it.
			await expect
				.poll(async () => {
					const scroller = page.getByTestId('thread-messages')
					return scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
				})
				.toBeLessThan(40)
			const lastBox = await last.boundingBox()
			const composerBox = await composer.boundingBox()
			expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0)).toBeLessThanOrEqual(composerBox?.y ?? 0)

			// Older messages run up behind the header instead of stopping at a hard edge.
			const scroller = page.getByTestId('thread-messages')
			const scrollerBox = await scroller.boundingBox()
			const headerBox = await page.getByRole('heading', { name: /Floating thread/ }).boundingBox()
			expect(scrollerBox?.y ?? 1e9).toBeLessThanOrEqual(headerBox?.y ?? 0)

			expect(await overflow(page)).toBeLessThanOrEqual(0)
		})
	}
})

const clear = (el: Element) => {
	const s = getComputedStyle(el)
	return { image: s.backgroundImage, color: s.backgroundColor, events: s.pointerEvents }
}

test.describe('Floating composers — item, agent, reply pane and trial banner', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the item comment bar has a solid backing with a fade @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const item = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: `Item ${vp.label}`,
				status: 'todo',
				content: 'Line of text\n\n'.repeat(60),
			})
			await page.goto(`/${account.workspaceId}/objects/${item.id}`)
			const input = page.getByLabel('Comment', { exact: true })
			await expect(input).toBeVisible({ timeout: 15_000 })
			const band = page.locator('div.sticky.bottom-0').filter({ has: input })
			const style = await band.evaluate(clear)
			// The bar sits on a backing that fades in above it, so body text never shows behind it,
			// and it takes clicks itself (it is not a click-through strip).
			expect(style.image).toContain('linear-gradient')
			expect(style.events).not.toBe('none')
			await input.click({ trial: true })
			expect(await overflow(page)).toBeLessThanOrEqual(0)
		})

		test(`the agent page composer is just the pill @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor(`Floaty ${vp.label}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}?tab=sessions`)
			const composer = page.getByTestId('agent-composer')
			await expect(composer).toBeVisible({ timeout: 15_000 })
			const band = composer.locator('xpath=..')
			expect(await band.evaluate(clear)).toEqual({
				image: 'none',
				color: 'rgba(0, 0, 0, 0)',
				events: 'none',
			})
			await composer.getByRole('textbox').first().click({ trial: true })
			expect(await overflow(page)).toBeLessThanOrEqual(0)
		})

		test(`the reply pane composer floats and the replies clear it @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor(`Reply QA ${vp.label}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Reply pane ${vp.label}`,
				participant_actor_ids: [agent.id],
				initial_message: 'Root of the thread',
			})
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await expect(page.getByTestId('thread-messages')).toBeVisible({ timeout: 15_000 })
			await page.getByRole('button', { name: 'Reply in thread' }).first().click({ force: true })
			const pane = page.locator('div[aria-label="Thread"]')
			await expect(pane).toBeVisible({ timeout: 10_000 })
			const footer = pane.locator('div.absolute.bottom-0')
			const style = await footer.evaluate(clear)
			expect(style).toEqual({ image: 'none', color: 'rgba(0, 0, 0, 0)', events: 'none' })
			const scroller = pane.locator('[data-floating-scroller]')
			const [pad, height] = await Promise.all([
				scroller.evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingBottom)),
				footer.evaluate((el) => el.getBoundingClientRect().height),
			])
			expect(pad).toBeGreaterThanOrEqual(height)
			expect(await overflow(page)).toBeLessThanOrEqual(0)
		})

		test(`the bar starts below the trial-expired banner @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.route('**/api/billing/usage*', async (route) => {
				const res = await route.fetch()
				const body = await res.json()
				await route.fulfill({
					response: res,
					json: { ...body, plan: 'trial', period_resets_in_ms: 0 },
				})
			})
			const loop = await seedLongFlow(account, `Banner ${vp.label}`)
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
			const banner = page.getByText(/trial has expired/i).first()
			await expect(banner).toBeVisible({ timeout: 15_000 })
			const bannerBox = await banner
				.locator('xpath=ancestor::div[contains(@class,"border-b")][1]')
				.boundingBox()
			const barBox = await page.locator('main > header').first().boundingBox()
			expect(barBox?.y ?? 0).toBeGreaterThanOrEqual(
				(bannerBox?.y ?? 0) + (bannerBox?.height ?? 0) - 1,
			)
		})
	}
})

test.describe('Screen title on a plain screen', () => {
	test('the Flows heading shows above the solid bar at desktop width', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1440, height: 900 })
		await page.goto(`/${account.workspaceId}/loops`)
		const heading = page.getByRole('heading', { level: 1, name: 'Flows' })
		await expect(heading).toBeVisible({ timeout: 15_000 })
		// The bar is solid, so a title painted under it is "visible" to Playwright but not to a
		// person. Let the bar take pointer events too, then the point at the heading's centre is
		// the heading itself only when nothing is drawn over it.
		const onTop = await heading.evaluate((el) => {
			const bar = document.querySelector<HTMLElement>('main > header')
			if (bar) bar.style.pointerEvents = 'auto'
			const box = el.getBoundingClientRect()
			return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === el
		})
		expect(onTop).toBe(true)
	})
})
