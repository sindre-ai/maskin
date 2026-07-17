import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T1 minimum: the agent detail page shows a Connect LinkedIn entry point when
// no account is connected on the workspace. Clicking it initiates the Unipile
// hosted-auth handoff. We can't drive the third-party Unipile page from CI, so
// this spec stubs the /api/linkedin/connect response and asserts the browser
// gets redirected to the stubbed URL — the same contract T4/T5 will read.

test.describe('LinkedIn connect entry point on agent detail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`renders Connect LinkedIn and hands off to Unipile at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			// Seed an agent actor and make it a workspace member. Route helpers only
			// expose createObject; agents are actors, so hit the API directly.
			// tools.capabilities: ['linkedin'] is what mounts the LinkedIn UI on the
			// agent detail page — a bare agent gets no LinkedIn UI at all.
			const agentRes = await page.request.post('http://localhost:5173/api/actors', {
				headers: {
					'content-type': 'application/json',
					Authorization: `Bearer ${account.apiKey}`,
				},
				data: {
					type: 'agent',
					name: `LinkedIn Test Agent ${Date.now()}`,
					tools: { mcpServers: {}, capabilities: ['linkedin'] },
				},
			})
			expect(agentRes.ok()).toBeTruthy()
			const agent = (await agentRes.json()) as { id: string }
			const memberRes = await page.request.post(
				`http://localhost:5173/api/workspaces/${account.workspaceId}/members`,
				{
					headers: {
						'content-type': 'application/json',
						Authorization: `Bearer ${account.apiKey}`,
					},
					data: { actor_id: agent.id, role: 'member' },
				},
			)
			expect(memberRes.ok()).toBeTruthy()

			// Stub the Unipile connect endpoint so no real Unipile call is made and
			// so the redirect target is deterministic across CI runs. Use a
			// same-origin URL so the browser can actually resolve it — Playwright's
			// waitForURL only fires once the frame lands on the new location, and a
			// bogus cross-origin domain (like `account.unipile.example`) never
			// resolves in CI. The follow-up route stub then returns a tiny 200 page
			// so the navigation completes cleanly.
			const stubUrl = 'http://localhost:5173/__linkedin_stub'
			await page.route('**/api/linkedin/connect', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ url: stubUrl }),
				})
			})
			await page.route('**/api/linkedin/account', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: 'null',
				})
			})
			await page.route('**/__linkedin_stub', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'text/html',
					body: '<!doctype html><title>stub</title>ok',
				})
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			// Scope the button lookup to the main content area — the sidebar's
			// workspace-switcher button carries the test title in its accessible
			// name (see auth.fixture), which otherwise collides with a plain
			// `getByRole('button', /connect linkedin/i)` under strict mode.
			const connectButton = page.locator('main').getByRole('button', { name: /connect linkedin/i })
			await expect(connectButton).toBeVisible({ timeout: 10000 })

			const nav = page.waitForURL('**/__linkedin_stub', { timeout: 10000 })
			await connectButton.click()
			await nav
			expect(page.url()).toContain('/__linkedin_stub')
		})
	}
})
