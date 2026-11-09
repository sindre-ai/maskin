import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * The flow page's Pipeline for every shape of flow: none, one, many, disabled, long names.
 * Each is read at the three ship-gate widths, and none may widen the page.
 */
type Account = { workspaceId: string; api: TestAPI }

async function agent(account: Account, name: string) {
	const a = await account.api.createAgentActor(name)
	await account.api.addWorkspaceMember(account.workspaceId, a.id)
	return a
}

async function flow(
	account: Account,
	title: string,
	steps: { agentId: string; name: string; type?: 'cron' | 'event'; enabled?: boolean }[],
) {
	const loop = await account.api.createObject(account.workspaceId, {
		type: 'loop',
		title,
		status: 'learning',
	})
	const ids: string[] = []
	for (const step of steps) {
		const t = await account.api.createTrigger(account.workspaceId, {
			name: step.name,
			type: step.type ?? 'event',
			action_prompt: `Do: ${step.name}`,
			target_actor_id: step.agentId,
			config:
				step.type === 'cron'
					? { expression: '0 9 * * 1' }
					: { entity_type: 'task', action: 'created' },
			enabled: step.enabled ?? true,
		})
		ids.push(t.id)
	}
	if (ids.length > 0) {
		await account.api.updateObject(loop.id, account.workspaceId, {
			metadata: { trigger_ids: ids },
		})
	}
	return loop
}

const pageOverflow = (page: import('@playwright/test').Page) =>
	page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

test.describe('Flow page — Pipeline for every shape of flow', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`no triggers says the flow runs when asked, with no card @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const loop = await flow(account, 'Bare flow', [])
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			await expect(page.getByRole('heading', { name: 'Pipeline' })).toBeVisible({
				timeout: 15_000,
			})
			await expect(page.getByText('This flow runs when you ask.')).toBeVisible()
			await expect(page.getByTestId('loop-pipeline')).toHaveCount(0)
			expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
		})

		test(`disabled triggers are dimmed with their switch off @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const a = await agent(account, 'Sleeper')
			const loop = await flow(account, 'Paused flow', [
				{ agentId: a.id, name: 'Paused sweep', type: 'cron', enabled: false },
			])
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const pipeline = page.getByTestId('loop-pipeline')
			await expect(pipeline).toBeVisible({ timeout: 15_000 })
			await expect(pipeline.getByRole('switch', { name: /Turn on Paused sweep/ })).not.toBeChecked()
			await expect(pipeline.getByText('Schedule', { exact: true })).toBeVisible()
			expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
		})

		test(`many agents scroll inside the card and long names stay inside it @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const steps: { agentId: string; name: string }[] = []
			const longAgent = await agent(
				account,
				'An agent with an extraordinarily long name that keeps going past any sensible column width',
			)
			steps.push({
				agentId: longAgent.id,
				name: 'A very long trigger name that must wrap cleanly inside its card and never push the switch out https://example.com/a/very/long/unbroken/url/segment/with/no/spaces',
			})
			for (let i = 1; i <= 6; i++) {
				const a = await agent(account, `Agent ${i}`)
				steps.push({ agentId: a.id, name: `Step ${i}` })
			}
			const loop = await flow(account, 'Crowded flow', steps)
			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const pipeline = page.getByTestId('loop-pipeline')
			await expect(pipeline).toBeVisible({ timeout: 15_000 })
			await expect(pipeline.getByRole('switch')).toHaveCount(7)
			// The card carries the overflow; the page does not.
			const [scroll, client] = await pipeline.evaluate((el) => [el.scrollWidth, el.clientWidth])
			expect(scroll).toBeGreaterThan(client)
			expect(await pageOverflow(page)).toBeLessThanOrEqual(0)
			// The long name's switch stays inside its own card.
			const longSwitch = pipeline.getByRole('switch', { name: /A very long trigger name/ })
			await longSwitch.scrollIntoViewIfNeeded()
			const sw = await longSwitch.boundingBox()
			const box = await pipeline.boundingBox()
			expect(sw && box && sw.x + sw.width <= box.x + box.width + 1).toBe(true)
			// Chips never grow past the page either.
			await expect(page.getByRole('button', { name: /^All steps/ })).toBeVisible()
		})
	}

	test('Add trigger adds one trigger to the flow even on a double click', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		const a = await agent(account, 'Relay')
		const loop = await flow(account, 'Growing flow', [{ agentId: a.id, name: 'First step' }])
		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

		await page.getByRole('button', { name: '+ Add trigger' }).dblclick()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers/`), {
			timeout: 15_000,
		})
		const stored = await account.api.getObject(loop.id, account.workspaceId)
		const ids = (stored.metadata?.trigger_ids ?? []) as string[]
		expect(ids).toHaveLength(2)
		// It starts paused, aimed at the flow's own agent, so it lands in an existing column.
		const added = (await account.api.listTriggers(account.workspaceId)).find(
			(t) => ids.includes(t.id) && t.name !== 'First step',
		)
		expect(added?.enabled).toBe(false)
		expect(added?.targetActorId).toBe(a.id)
	})
})
