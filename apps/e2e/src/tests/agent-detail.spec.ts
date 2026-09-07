import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — header and Usage block', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders header, outcome line and Usage block @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const outcome = 'Keeps the marketing pipeline unclogged'
			const agent = await account.api.createAgentActor('Ada Atom')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			// Set the one-line role that surfaces as "Owns one outcome". The
			// PATCH goes through the same schema the UI reads back from useActor.
			await (
				account.api as unknown as {
					updateActor(id: string, data: { description: string }): Promise<unknown>
				}
			).updateActor(agent.id, { description: outcome })

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('heading', { name: 'Ada Atom' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByText('Owns one outcome:')).toBeVisible()
			await expect(page.getByText(outcome)).toBeVisible()

			// The one agent-level action is the enable/disable switch, in the detail
			// bar (mockup 2313), reachable at every viewport…
			const stateToggle = page.getByRole('button', { name: /Disable agent|Enable agent/ })
			await expect(stateToggle).toBeVisible()
			// …and never duplicated into the page body beside the outcome line.
			await expect(
				page.locator('.max-w-3xl').getByRole('button', { name: /Disable agent|Enable agent/ }),
			).toHaveCount(0)

			// Usage block: label, tabs, both columns, budget line.
			const usage = page.getByRole('region', { name: 'Usage' })
			await expect(usage).toBeVisible()
			await expect(usage.getByText('Usage', { exact: true })).toBeVisible()
			await expect(usage.getByRole('button', { name: '24h' })).toBeVisible()
			await expect(usage.getByRole('button', { name: '30d' })).toBeVisible()
			await expect(usage.getByText('tokens used')).toBeVisible()
			await expect(usage.getByText('sessions', { exact: true })).toBeVisible()
			await expect(usage.getByText('TOKENS / MONTH')).toBeVisible()
			// No cap is configured, so the budget row reports the month's spend.
			await expect(usage.getByText(/No cap — .+ this month/)).toBeVisible()

			// Switching to 7d re-labels the chart — proves the tabs drive the
			// window, not just cosmetic state.
			await usage.getByRole('button', { name: '7d' }).click()
			await expect(usage.getByText('TOKENS / WEEK')).toBeVisible()

			// 90d is the mockup's third period (2381) and gets its own label.
			await usage.getByRole('button', { name: '90d' }).click()
			await expect(usage.getByText('TOKENS / QUARTER')).toBeVisible()

			// The header and Usage block render in both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('heading', { name: 'Ada Atom' })).toBeVisible()
				await expect(usage).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})

		// The v2 detail bar and the order the page reads in (mockup 2309–2490).
		test(`detail bar, identity row and section order @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor('Orla Order')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('region', { name: 'Instructions' })).toBeVisible({
				timeout: 15_000,
			})

			// `Agents › {name}` replaces the nav row's <h1>, and the crumb links back.
			// Scoped to the detail bar — the sidebar carries an "Agents" link too.
			const crumb = page.locator('header').getByRole('link', { name: 'Agents', exact: true })
			await expect(crumb).toBeVisible()

			// The one agent-level control is the enable/disable switch, in both schemes.
			const disable = page.getByRole('button', { name: /Disable agent/ })
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(disable).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })

			// Instructions comes before Skills, which comes before Tools.
			const order = await page
				.locator('section[aria-labelledby]')
				.evaluateAll((els) =>
					els.map((e) => e.getAttribute('aria-labelledby') ?? '').filter(Boolean),
				)
			const at = (id: string) => order.findIndex((v) => v.includes(id))
			expect(at('instructions')).toBeGreaterThanOrEqual(0)
			expect(at('instructions')).toBeLessThan(at('skills'))
			expect(at('skills')).toBeLessThan(at('tools'))

			// Disabling the agent flips the control to Enable and the status word with it.
			await disable.click()
			await expect(page.getByRole('button', { name: /Enable agent/ })).toBeVisible({
				timeout: 15_000,
			})
		})
	}
})

test.describe('Agent detail — inline identity editing', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renames the agent and edits its outcome @ ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Bo Byte')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			await expect(page.getByRole('heading', { name: 'Bo Byte' })).toBeVisible({ timeout: 10_000 })

			// Name — the editor is reachable on touch (no hover-only reveal).
			const editName = page.getByRole('button', { name: 'Edit agent name' })
			await expect(editName).toBeVisible()
			await editName.click()
			const nameField = page.getByRole('textbox', { name: 'Agent name' })
			await nameField.fill('Bo Bytesmith')
			await nameField.press('Enter')
			await expect(page.getByRole('heading', { name: 'Bo Bytesmith' })).toBeVisible()

			// Outcome — starts unset, so the placeholder is the edit target.
			const editOutcome = page.getByRole('button', { name: 'Edit outcome' })
			await expect(editOutcome).toBeVisible()
			await editOutcome.click()
			const outcomeField = page.getByRole('textbox', { name: 'Outcome' })
			await outcomeField.fill('Keeps the build green')
			await outcomeField.press('Enter')
			await expect(page.getByText('Keeps the build green')).toBeVisible()

			// Both edits persisted, not just optimistic UI.
			await page.reload()
			await expect(page.getByRole('heading', { name: 'Bo Bytesmith' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByText('Keeps the build green')).toBeVisible()

			// The edit affordances render in both colour schemes.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('button', { name: 'Edit agent name' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
