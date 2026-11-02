import { expect, test } from '../fixtures/auth.fixture'
import { clearSeededAutomations } from '../helpers/seed.helper'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loops list page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`empty workspace renders the empty state at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText('No flows running here yet')).toBeVisible({ timeout: 10000 })
		})

		test(`renders a loop row with derived stats at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)

			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback',
				status: 'learning',
				content: 'Every customer who gives feedback hears back within 30 days',
			})

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText('Customer feedback')).toBeVisible({ timeout: 10000 })
			await expect(page.getByTestId('loop-pill')).toHaveText('Learning')
		})

		test(`page search narrows flows; both searches are reachable with no sideways scroll at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)
			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Alpha pipeline',
				status: 'learning',
			})
			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Zulu pipeline',
				status: 'learning',
			})
			await page.goto(`/${account.workspaceId}/loops`)
			await expect(page.getByText('Alpha pipeline')).toBeVisible({ timeout: 10000 })

			// The header has no workspace search button; the one New stays beside the page's own search.
			await expect(page.getByRole('button', { name: 'Search or run a command' })).toHaveCount(0)
			await expect(page.getByRole('button', { name: /^New/ }).first()).toBeVisible()
			const overflow = await page.evaluate(() => ({
				scroll: document.documentElement.scrollWidth,
				client: document.documentElement.clientWidth,
			}))
			expect(overflow.scroll).toBeLessThanOrEqual(overflow.client)

			// A field from xl up, an icon below it that opens an inline field.
			if (viewport.width < 1280) {
				await expect(page.getByRole('searchbox', { name: 'Search flows' })).toBeHidden()
				await page.getByRole('button', { name: 'Search flows' }).click()
			}
			const search = page.getByRole('searchbox', { name: 'Search flows' })
			await expect(search).toBeVisible()
			await search.fill('zulu')
			await expect(page.getByText('Zulu pipeline')).toBeVisible()
			await expect(page.getByText('Alpha pipeline')).toHaveCount(0)
			await search.fill('zzzz-nothing')
			await expect(page.getByText('No flows match.')).toBeVisible()
			await search.fill('')
			await expect(page.getByText('Alpha pipeline')).toBeVisible()
		})

		test(`Display menu filters by Area, and a flow with a target shows its progress at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)
			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Sales pipeline',
				status: 'learning',
				metadata: {
					tags: ['Sales'],
					targets: [{ label: 'customers closed', source: 'manual', actual: 0, target: 10 }],
				},
			})
			await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Product pipeline',
				status: 'learning',
				metadata: { tags: ['Product'] },
			})
			await page.goto(`/${account.workspaceId}/loops`)
			await expect(page.getByText('Sales pipeline')).toBeVisible({ timeout: 10000 })

			// Only the flow with a target carries a bar, and a target nobody has met is Missed.
			await expect(page.getByRole('progressbar')).toHaveCount(1)
			await expect(
				page.getByRole('progressbar', { name: '0 of 10 customers closed' }),
			).toBeVisible()
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByText('Missed', { exact: true })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Display → Area narrows the list; Reset filters brings it back.
			await page.getByRole('button', { name: /^Display/ }).click()
			const area = page.getByRole('button', { name: /Area.*All/ })
			await area.click()
			await page
				.locator('div', { has: area })
				.last()
				.getByRole('button', { name: /^Product/ })
				.click()
			await page.keyboard.press('Escape')
			await expect(page.getByText('Product pipeline')).toBeVisible()
			await expect(page.getByText('Sales pipeline')).toHaveCount(0)

			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByRole('button', { name: 'Reset filters' }).click()
			await page.keyboard.press('Escape')
			await expect(page.getByText('Sales pipeline')).toBeVisible()
		})

		test(`/triggers redirects to /loops and lists its triggers there at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Nightly sweep',
				type: 'cron',
				action_prompt: 'Sweep the backlog',
				target_actor_id: agent.id,
				config: { expression: '0 3 * * *' },
			})

			await page.goto(`/${account.workspaceId}/triggers`)

			// The v2 sidebar has no Triggers entry — the bookmark must land on Loops.
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops$`), { timeout: 10000 })
			await expect(page.getByText('Not tied to a flow')).toBeVisible()
			await expect(page.getByText('Nightly sweep', { exact: true })).toBeVisible()
		})

		test(`a workspace with triggers but no loops still lists them at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await account.api.createTrigger(account.workspaceId, {
				name: 'Unattached watcher',
				type: 'event',
				action_prompt: 'Watch for new insights',
				target_actor_id: agent.id,
				config: { entity_type: 'insight', action: 'created' },
			})

			await page.goto(`/${account.workspaceId}/loops`)

			// Ungating this section is the whole reason the fold-in is safe.
			await expect(page.getByText('Unattached watcher', { exact: true })).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText('No flows running here yet')).toBeVisible()
		})
	}

	test('a /triggers/{id} deep link still resolves after the fold-in', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Deep linked trigger',
			type: 'event',
			action_prompt: 'Summarise the new event',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})

		await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers/${trigger.id}`), {
			timeout: 10000,
		})
		await expect(page.getByRole('heading', { name: 'TRIGGER TYPE' })).toBeVisible({
			timeout: 10000,
		})
		// Its breadcrumb now hangs off Loops, not a page that would bounce.
		await expect(
			page.getByRole('navigation', { name: 'breadcrumb' }).getByText('Flows', { exact: true }),
		).toBeVisible()
	})

	test('sidebar Loops entry navigates to /loops', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })
		await page.goto(`/${account.workspaceId}`)

		await page.getByRole('link', { name: 'Flows' }).click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops`), { timeout: 10000 })
	})

	test('Display → Ordering changes row order and survives a reload', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Alpha loop',
			status: 'learning',
		})
		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Zulu loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('Alpha loop')).toBeVisible({ timeout: 10000 })

		await page.getByRole('button', { name: 'Display' }).click()
		await page
			.getByRole('button', { name: /^Sort by/ })
			.first()
			.click()
		await page.getByRole('menuitem', { name: 'Name' }).click()
		await page.keyboard.press('Escape')

		const namesAfterSort = async () => {
			const rows = page.locator('a[href*="/loops/"]')
			return (await rows.allTextContents()).join(' | ')
		}
		await expect.poll(namesAfterSort).toContain('Alpha loop')

		await page.reload()
		await expect(page.getByText('Alpha loop')).toBeVisible({ timeout: 10000 })
		// The persisted ordering comes back from the user display-settings row.
		await page.getByRole('button', { name: 'Display' }).click()
		await expect(page.getByRole('button', { name: /^Sort by Name/ })).toBeVisible()
	})

	test('toggling a standalone trigger flips enabled without navigating away', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		await account.api.createTrigger(account.workspaceId, {
			name: 'Toggle me',
			type: 'event',
			action_prompt: 'Watch for new insights',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})

		await page.goto(`/${account.workspaceId}/loops`)
		const toggle = page.getByRole('switch', { name: 'Disable Toggle me' })
		await expect(toggle).toBeVisible({ timeout: 10000 })

		await toggle.click()

		// The switch must not be swallowed by the row's navigation overlay.
		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops$`))
		await expect(page.getByRole('switch', { name: 'Enable Toggle me' })).toBeVisible()

		await page.reload()
		await expect(page.getByRole('switch', { name: 'Enable Toggle me' })).toBeVisible({
			timeout: 10000,
		})
	})

	test('an "Assigned in chat" row opens the conversation it came from', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: 'Look into the churn spike',
			participant_actor_ids: [agent.id],
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('Assigned in chat')).toBeVisible({ timeout: 10000 })

		await page.getByText('Look into the churn spike').click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/chats/${conversation.id}`), {
			timeout: 10000,
		})
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`a failed loops fetch shows the error card, not the empty state, at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			await page.route('**/api/loops**', (route) =>
				route.fulfill({
					status: 500,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'Internal Server Error' }),
				}),
			)

			await page.goto(`/${account.workspaceId}/loops`)

			await expect(page.getByText("Couldn't load flows")).toBeVisible({ timeout: 10000 })
			// The empty state would claim the workspace has no loops — it must not
			// stand in for a fetch that failed.
			await expect(page.getByText('No flows running here yet')).toBeHidden()

			// The retry control is reachable on touch and reads in both modes.
			const retry = page.getByRole('button', { name: /try again|retry/i })
			await expect(retry).toBeVisible()
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(page.getByText("Couldn't load flows")).toBeVisible()
			await page.emulateMedia({ colorScheme: 'light' })
		})

		test(`both non-loop groups render with their own empty states at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)

			await page.goto(`/${account.workspaceId}/loops`)

			// /triggers redirects here, so this list is the only way in — the two
			// sections must announce themselves even with nothing in them.
			await expect(page.getByText('Not tied to a flow')).toBeVisible({ timeout: 10000 })
			await expect(page.getByText('No workspace-wide automations yet')).toBeVisible()
			await expect(page.getByText('Assigned in chat')).toBeVisible()
			await expect(page.getByText('Nothing handed to an agent in chat')).toBeVisible()
		})
	}

	test('an assigned-in-chat row names the loop the work feeds', async ({ page, account }) => {
		await page.setViewportSize({ width: 1280, height: 900 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Feeds the flow',
			type: 'event',
			action_prompt: 'Watch for new insights',
			target_actor_id: agent.id,
			config: { entity_type: 'insight', action: 'created' },
		})
		await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Churn watch',
			status: 'learning',
			metadata: { trigger_ids: [trigger.id] },
		})
		await account.api.createConversation(account.workspaceId, {
			title: 'Look into the churn spike',
			participant_actor_ids: [agent.id],
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await expect(page.getByText('Look into the churn spike')).toBeVisible({ timeout: 10000 })
		// The agent's own "Meet Relay" intro chat feeds the same loop, so the label shows twice.
		await expect(page.getByText('feeds Churn watch').first()).toBeVisible()
	})

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`Cards are the default view and List stays a choice at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			test.setTimeout(150000)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await clearSeededAutomations(account.api, account.workspaceId)
			for (const title of ['Alpha flow', 'Beta flow']) {
				await account.api.createObject(account.workspaceId, {
					type: 'loop',
					title,
					status: 'learning',
					metadata: { targets: [{ label: 'deals', source: 'manual', actual: 4, target: 10 }] },
				})
			}
			await page.goto(`/${account.workspaceId}/loops`)

			const cards = page.getByTestId('loop-card')
			await expect(cards).toHaveCount(2, { timeout: 45000 })
			await expect(cards.first().getByText('4 of 10')).toBeVisible()
			await expect(page.getByTestId('flows-brief')).toContainText('No flows need you.')

			// One column below md, two from md up.
			const boxes = await cards.evaluateAll((nodes) =>
				nodes.map((n) => {
					const r = n.getBoundingClientRect()
					return { x: r.x, y: r.y }
				}),
			)
			if (viewport.width < 768) expect(boxes[1].x).toBe(boxes[0].x)
			else expect(boxes[1].y).toBe(boxes[0].y)

			// Choosing List sticks across a reload.
			await page.getByRole('button', { name: /^Display/ }).click()
			await page.getByText('View: List', { exact: true }).click()
			await page.keyboard.press('Escape')
			await expect(page.getByTestId('loop-card')).toHaveCount(0)
			await page.reload()
			await expect(page.getByText('Alpha flow')).toBeVisible({ timeout: 45000 })
			await expect(page.getByTestId('loop-card')).toHaveCount(0)
		})
	}
})
