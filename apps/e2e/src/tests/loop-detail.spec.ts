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
			// Scoped to the stat block — "in progress" also reads in prose
			// elsewhere on the page, which otherwise makes these ambiguous.
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
			// The shared object timeline replaces the old loop-specific activity
			// and changes sections — same Activity rule the object page carries.
			await expect(page.getByText('Activity', { exact: true })).toBeVisible()
			// The filter chips carry their count in the label — `All (3)`.
			await expect(page.getByRole('button', { name: /^All \(\d+\)$/ })).toBeVisible()

			// The composer is the last thing in the reader column — it sits below
			// the timeline, not above the story. Compare document order rather
			// than bounding boxes: the composer is `sticky bottom-0`, so while the
			// timeline is below the fold its pinned y is the smaller number at
			// every viewport where the page scrolls.
			const composer = page.getByPlaceholder('Listening — speak in plain words')
			const composerFollowsActivity = await composer.evaluate((node) => {
				const activity = [...document.querySelectorAll('span')].find(
					(el) => el.textContent?.trim() === 'Activity',
				)
				if (!activity) throw new Error('missing Activity label')
				// DOCUMENT_POSITION_FOLLOWING — the composer comes after it.
				return Boolean(activity.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
			})
			expect(composerFollowsActivity).toBe(true)

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

	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`title and description edit in place and persist at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const loop = await account.api.createObject(account.workspaceId, {
				type: 'loop',
				title: 'Renewals loop',
				status: 'learning',
				content: 'Every renewal is reviewed before it lapses',
			})

			await page.goto(`/${account.workspaceId}/loops/${loop.id}`)

			// Title: click the heading, type, commit with Enter.
			const heading = page.getByRole('heading', { name: 'Renewals loop' })
			await expect(heading).toBeVisible({ timeout: 10000 })
			await heading.click()
			const titleField = page.getByLabel('Loop title')
			await titleField.fill('Renewals loop v2')
			await titleField.press('Enter')
			await expect(page.getByRole('heading', { name: 'Renewals loop v2' })).toBeVisible()

			// Description: click the rendered markdown, type, commit on blur.
			await page.getByText('Every renewal is reviewed before it lapses').click()
			const body = page.getByLabel('Description')
			await expect(body).toBeVisible()
			await body.fill('Every renewal is reviewed **two weeks** before it lapses')
			await body.blur()
			await expect(page.getByText('two weeks')).toBeVisible()

			await page.reload()
			await expect(page.getByRole('heading', { name: 'Renewals loop v2' })).toBeVisible({
				timeout: 10000,
			})
			await expect(page.getByText('two weeks')).toBeVisible()

			// The pre-v2 edit affordance is gone — the page itself is the editor.
			await expect(page.getByRole('button', { name: 'Edit this loop' })).toHaveCount(0)
			await expect(page.getByText('say what should change — no builder')).toHaveCount(0)
		})
	}

	test('long unbroken step-description text does not overflow the viewport on mobile', async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: 375, height: 812 })

		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const loop = await account.api.createObject(account.workspaceId, {
			type: 'loop',
			title: 'Customer feedback loop',
			status: 'running',
		})
		const actionPrompt =
			'https://example.com/customer/feedback/some-very-long-unbroken-url-that-must-wrap-and-not-overflow-on-a-mobile-viewport-width'
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Triage feedback',
			type: 'event',
			action_prompt: actionPrompt,
			target_actor_id: agent.id,
			config: { entity_type: 'object', action: 'created' },
		})
		await account.api.updateObject(loop.id, account.workspaceId, {
			metadata: { trigger_ids: [trigger.id] },
		})

		await page.goto(`/${account.workspaceId}/loops/${loop.id}`)
		await expect(page.getByText('The loop, right now')).toBeVisible({ timeout: 10000 })
		await expect(page.getByText(actionPrompt)).toBeVisible()

		const fitsViewport = await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		)
		expect(fitsViewport).toBe(true)
	})

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
