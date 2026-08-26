import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Loop detail page', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders title, stats, and steps at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Customer feedback loop',
				status: 'learning',
				content: 'Every customer who gives feedback hears back within 30 days',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Triage feedback',
				type: 'event',
				action_prompt: 'Normalises the Slack event into the shared source',
				target_actor_id: agent.id,
				config: { entity_type: 'object', action: 'created' },
			})
			// Trigger membership lives on the loop row (metadata.trigger_ids per the
			// T1 architecture decision) rather than a relationship, since a trigger
			// can outlive the loop it's currently attached to — see loops.ts.
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id] },
			})
			const insight = await account.api.createObject(account.workspaceId, {
				type: 'insight',
				title: 'Setup confusion drives trial churn',
				status: 'new',
			})
			await account.api.createRelationship(account.workspaceId, {
				source_type: 'object',
				source_id: loop.id,
				target_type: 'object',
				target_id: insight.id,
				type: 'in_loop',
			})

			await page.goto(`/${account.workspaceId}/loops`)
			await page.getByText('Customer feedback loop').click()

			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops/${loop.id}`), {
				timeout: 10000,
			})
			await expect(page.getByRole('heading', { name: 'Customer feedback loop' })).toBeVisible({
				timeout: 10000,
			})
			await expect(
				page.getByText('Every customer who gives feedback hears back within 30 days').first(),
			).toBeVisible()
			// The four-sentence plain-language summary renders from the same loop.
			await expect(page.getByTestId('loop-summary')).toContainText(
				'Every customer who gives feedback hears back within 30 days',
			)
			// Scoped to the stat block — the plain-language summary above also
			// contains "in progress" in prose form ("Right now N items are in
			// progress."), which otherwise makes these locators ambiguous.
			const stats = page.getByTestId('loop-stats')
			await expect(stats.getByText('in progress')).toBeVisible()
			await expect(stats.getByText('closed')).toBeVisible()
			await expect(stats.getByText('median to close')).toBeVisible()
			await expect(page.getByText('The loop, right now')).toBeVisible()
			// AC5 — the utterance input is present on loop detail.
			await expect(page.getByPlaceholder('Listening — speak in plain words')).toBeVisible()
			await expect(
				page.getByText('Normalises the Slack event into the shared source'),
			).toBeVisible()
			// The right-now note reads as one line: primitives · triggers on ·
			// cycles (mockup 1891).
			await expect(page.getByText(/of \d+ trigger(s)? on/)).toBeVisible()
			// T2 sections — latest activity and the changes log with undo. Latest
			// activity is a plain heading + rule, the same register as Changes
			// (mockup 1949–1950) — no bordered card around it.
			await expect(page.getByRole('heading', { name: 'Latest activity' })).toBeVisible()
			await expect(page.getByText('what the agents did last')).toBeVisible()
			await expect(page.getByRole('heading', { name: 'Changes' })).toBeVisible()
			await expect(page.getByRole('button', { name: /undo/i }).first()).toBeVisible()

			// The composer is the last thing in the reader column — it sits below
			// the Changes section, not above the story. Compare document order
			// rather than bounding boxes: the composer is `sticky bottom-0`, so
			// while Changes is below the fold its pinned y is the smaller number
			// at every viewport where the page scrolls.
			const composer = page.getByPlaceholder('Listening — speak in plain words')
			const composerFollowsChanges = await composer.evaluate((node, changesText) => {
				const changes = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].find(
					(heading) => heading.textContent?.trim() === changesText,
				)
				if (!changes) throw new Error('missing Changes heading')
				// DOCUMENT_POSITION_FOLLOWING — the composer comes after it.
				return Boolean(changes.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
			}, 'Changes')
			expect(composerFollowsChanges).toBe(true)

			// A step row is the only route into a loop-owned trigger now that
			// /triggers redirects.
			await page.getByText('Normalises the Slack event into the shared source').click()
			await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/triggers/${trigger.id}`), {
				timeout: 10000,
			})
		})

		test(`pre-first-run banner reads in light and dark at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agent = await account.api.createAgentActor('Relay')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Brand new loop',
				status: 'learning',
			})
			const trigger = await account.api.createTrigger(account.workspaceId, {
				name: 'Nightly sweep',
				type: 'cron',
				action_prompt: 'Sweep the backlog',
				target_actor_id: agent.id,
				config: { expression: '0 3 * * *' },
			})
			await account.api.updateObject(loop.id, account.workspaceId, {
				metadata: { trigger_ids: [trigger.id] },
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			const banner = page.getByText(/Built from what you said — nothing has fired yet/)
			await page.emulateMedia({ colorScheme: 'light' })
			await expect(banner).toBeVisible({ timeout: 10000 })
			await page.emulateMedia({ colorScheme: 'dark' })
			await expect(banner).toBeVisible()
			await expect(page.getByText(/The first cycle opens/)).toBeVisible()
		})
	}

	test('submitting an utterance opens the chat panel with the loop attached (AC5)', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Feedback loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		const input = page.getByPlaceholder('Listening — speak in plain words')
		await expect(input).toBeVisible({ timeout: 10000 })

		await input.fill('Tighten the close timeline')
		await input.press('Enter')

		// The utterance is forwarded to the chat-driven edit path: navigates to
		// a new chat with the loop attached via the `objectId` search param. The
		// local input unmounts as part of that navigation (timing between the
		// synchronous clear and the route swap isn't reliably observable), so
		// the destination is the only thing worth asserting here.
		await expect(page).toHaveURL(new RegExp(`chats/new\\?.*objectId=${loop.id}`), {
			timeout: 10000,
		})
		await expect(page.getByRole('heading', { name: 'New chat', exact: true })).toBeVisible()
	})

	test('Pause/Resume toggles the loop pill', async ({ page, account }) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Billing reliability loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await expect(page.getByTestId('loop-pill')).toHaveText('Learning', { timeout: 10000 })

		// Exact — the v2 header's split New button adds a "More ways to start"
		// control, which a substring match would also pick up.
		await page.getByRole('button', { name: 'More', exact: true }).click()
		await page.getByRole('menuitem', { name: 'Pause loop' }).click()

		await expect(page.getByTestId('loop-pill')).toHaveText('Paused', { timeout: 10000 })
	})

	test('clicking a loop row from /loops navigates to the dedicated detail page, not the generic object page', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 })

		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Churn early-warning loop',
			status: 'learning',
		})

		await page.goto(`/${account.workspaceId}/loops`)
		await page.getByText('Churn early-warning loop').click()

		await expect(page).toHaveURL(new RegExp(`${account.workspaceId}/loops/${loop.id}`), {
			timeout: 10000,
		})
		await expect(page).not.toHaveURL(new RegExp(`${account.workspaceId}/objects/${loop.id}`))
	})
})
