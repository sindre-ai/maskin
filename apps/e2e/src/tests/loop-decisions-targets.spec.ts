import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The flow page's Decisions card and Targets block, at the three ship-gate widths.
 * Neither may widen the page; Targets fall to one column when the box is under two cards.
 */
type Account = Parameters<Parameters<typeof test>[2]>[0] extends never
	? never
	: {
			workspaceId: string
			actorId: string
			api: import('../helpers/api.helper').TestAPI
		}

async function seedFlow(
	account: Account,
	opts: { title: string; asks?: number; targets?: number },
) {
	const agent = await account.api.createAgentActor('Researcher')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	const trigger = await account.api.createTrigger(account.workspaceId, {
		name: 'Draft the brief',
		type: 'event',
		action_prompt: 'Draft it',
		target_actor_id: agent.id,
		config: { entity_type: 'task', action: 'created' },
	})
	const targets = [
		{ label: 'Pages in the top 10', source: 'metric:seo.top10', actual: 27, target: 40 },
		{ label: 'Terms in the top 20', source: 'metric:seo.top20', actual: 4, target: 10 },
		{ label: 'Customers closed', source: 'metric:sales.closed', actual: 0, target: 10 },
		{ label: 'Integrations shipped', source: 'metric:product.shipped', actual: 8, target: 8 },
	].slice(0, opts.targets ?? 0)
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title: opts.title,
		status: 'learning',
	})
	await account.api.updateObject(loop.id, account.workspaceId, {
		metadata: { trigger_ids: [trigger.id], ...(targets.length > 0 ? { targets } : {}) },
	})
	for (let i = 1; i <= (opts.asks ?? 0); i++) {
		const task = await account.api.createObject(account.workspaceId, {
			type: 'task',
			title: `Draft page ${i}`,
			status: 'todo',
		})
		await account.api.createRelationship(account.workspaceId, {
			source_type: 'object',
			source_id: loop.id,
			target_type: 'object',
			target_id: task.id,
			type: 'in_loop',
		})
		await account.api.createNotification(account.workspaceId, {
			type: 'needs_input',
			title: `Ok to publish page ${i}?`,
			source_actor_id: agent.id,
			target_actor_id: account.actorId,
			object_id: task.id,
		})
	}
	return loop
}

const pageOverflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('Flow page — Decisions and Targets', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`the Decisions card lists what waits and selects @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const loop = await seedFlow(account, { title: 'Review flow', asks: 3 })
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const card = page.getByTestId('loop-decisions-card')
			await expect(card).toBeVisible({ timeout: 15_000 })
			await expect(card.getByText('3 tasks are waiting for you')).toBeVisible()
			await expect(card.getByRole('link', { name: /Draft page 1/ })).toBeVisible()
			await expect(card.getByText('Ok to publish page 2?')).toBeVisible()

			await card.getByRole('button', { name: 'Select all' }).click()
			await expect(card.getByText('3 selected')).toBeVisible()
			await expect(card.getByRole('checkbox', { name: /Select Draft page 3/ })).toBeChecked()
			expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
			// The Overview tab and the header chip say the same count.
			await expect(page.getByTestId('loop-decisions-chip')).toHaveText('3 decisions needed')
		})

		test(`one ask reads in the singular and none shows no card @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const one = await seedFlow(account, { title: 'One ask', asks: 1 })
			const none = await seedFlow(account, { title: 'No asks' })

			await page.goto(`/${account.workspaceId}/loops/${one.id}`)
			await expect(page.getByText('1 task is waiting for you')).toBeVisible({ timeout: 15_000 })
			await expect(page.getByTestId('loop-decisions-chip')).toHaveText('1 decision needed')

			await page.goto(`/${account.workspaceId}/loops/${none.id}`)
			await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByTestId('loop-decisions-card')).toHaveCount(0)
			await expect(page.getByTestId('loop-decisions-chip')).toHaveCount(0)
		})

		test(`targets: 1, 2 and 4 cards, one column when narrow @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			for (const n of [1, 2, 4]) {
				const loop = await seedFlow(account, { title: `Targets ${n}`, targets: n })
				await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
				const cards = page.getByTestId('target-card')
				await expect(cards).toHaveCount(n, { timeout: 15_000 })
				await expect(cards.first().getByText('27 of 40')).toBeVisible()
				const lefts = await cards.evaluateAll((els) => [
					...new Set(els.map((e) => Math.round(e.getBoundingClientRect().left))),
				])
				// Under 600px of room the cards stack in one column.
				if (vp.width < 1024) expect(lefts).toHaveLength(1)
				expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
			}
		})
	}

	test('the stage pill changes the flow stage', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const loop = await seedFlow(account, { title: 'Staged flow' })
		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await page.getByTestId('loop-pill').click()
		await page.getByRole('menuitem', { name: 'Supervised' }).click()

		await expect(page.getByTestId('loop-pill')).toContainText('Supervised')
		await expect
			.poll(async () => (await account.api.getObject(loop.id, account.workspaceId)).status)
			.toBe('supervised')
	})
})

test.describe('Flow page — reorder Targets', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a target moves with its handle and keeps its place after a reload @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const loop = await seedFlow(account, { title: 'Reorder targets', targets: 3 })
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const labels = () =>
				page.getByTestId('target-card').locator('.line-clamp-2').allTextContents()
			await expect(page.getByTestId('target-card')).toHaveCount(3, { timeout: 15_000 })
			expect(await labels()).toEqual([
				'Pages in the top 10',
				'Terms in the top 20',
				'Customers closed',
			])

			// The handle is on the card itself, not behind a hover, so a touch screen reaches it.
			const handle = page.getByRole('button', { name: 'Move Pages in the top 10' })
			await expect(handle).toBeVisible()
			expect(
				await page.evaluate(
					() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
				),
			).toBeLessThanOrEqual(0)

			// Lift with Space, move one place, drop with Space. The cards sit in one column on a phone.
			await handle.focus()
			await page.keyboard.press('Space')
			await page.keyboard.press(vp.width < 768 ? 'ArrowDown' : 'ArrowRight')
			await page.keyboard.press('Space')

			await expect
				.poll(labels)
				.toEqual(['Terms in the top 20', 'Pages in the top 10', 'Customers closed'])

			await page.reload()
			await expect(page.getByTestId('target-card')).toHaveCount(3, { timeout: 15_000 })
			expect(await labels()).toEqual([
				'Terms in the top 20',
				'Pages in the top 10',
				'Customers closed',
			])
		})
	}
})
