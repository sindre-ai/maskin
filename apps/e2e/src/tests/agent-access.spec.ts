import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// Per-agent integration access.
//
// The grants API is intercepted rather than seeded, because what these tests own
// is the SURFACE — that an ungranted agent is shown as holding nothing, that
// narrowing to read-only or to a chosen set is reachable, and that the request
// carries what the user picked. Whether the boundary actually holds is proven
// server-side, where it is enforced.

const REF = 'w0123456789abcdef0123456789abcdef_linear'

const TOOLS = [
	{ name: 'list_issues', description: 'List issues', readOnly: true },
	{ name: 'get_issue', description: 'Read one issue', readOnly: true },
	{ name: 'create_issue', description: 'Open an issue', readOnly: false },
	// The provider did not say. It must never be swept into a read-only grant.
	{ name: 'run_automation', description: 'Run something', readOnly: null },
]

const stubGrants = async (
	page: import('@playwright/test').Page,
	opts: { grants: Array<Record<string, unknown>>; onPut?: (body: unknown) => void },
) => {
	await page.route('**/api/tool-grants**', async (route) => {
		const method = route.request().method()
		if (method === 'PUT') {
			opts.onPut?.(route.request().postDataJSON())
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					id: 'g1',
					actorId: 'a',
					integrationRef: REF,
					mode: 'all',
					tools: [],
				}),
			})
		}
		if (method === 'DELETE') {
			return route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ revoked: true }),
			})
		}
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ grants: opts.grants, tools: { [REF]: TOOLS } }),
		})
	})
}

const gotoAgent = async (
	page: import('@playwright/test').Page,
	account: {
		workspaceId: string
		api: {
			createAgentActor(n: string): Promise<{ id: string }>
			addWorkspaceMember(w: string, a: string): Promise<unknown>
		}
	},
) => {
	const agent = await account.api.createAgentActor('Ada Atom')
	await account.api.addWorkspaceMember(account.workspaceId, agent.id)
	await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
	return agent
}

test.describe('agent integration access', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`shows what an agent may reach at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			let agentId = ''
			await page.route('**/api/tool-grants**', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						grants: [{ id: 'g1', actorId: agentId, integrationRef: REF, mode: 'all', tools: [] }],
						tools: { [REF]: TOOLS },
					}),
				})
			})

			const agent = await gotoAgent(page, account)
			agentId = agent.id
			await page.reload()

			await expect(page.getByRole('heading', { name: 'Integration access' })).toBeVisible({
				timeout: 10_000,
			})
			// The namespaced slug must never surface — nobody should read w0123….
			await expect(page.getByText('linear', { exact: true })).toBeVisible()
			await expect(page.getByText(REF)).toHaveCount(0)
			await expect(page.getByText('All tools')).toBeVisible()
		})
	}

	test('says plainly when an agent holds nothing', async ({ page, account }) => {
		// The default. It should read as a deliberate state, not a loading gap —
		// and it should mention the credential, which is the part people miss.
		await stubGrants(page, { grants: [] })
		await gotoAgent(page, account)

		await expect(page.getByText('No integrations granted')).toBeVisible({ timeout: 10_000 })
		await expect(page.getByText(/holds none of their credentials/)).toBeVisible()
	})

	test('narrows a grant to read-only and sends that', async ({ page, account }) => {
		let put: { mode?: string; tools?: string[] } | null = null
		let agentId = ''
		await page.route('**/api/tool-grants**', async (route) => {
			if (route.request().method() === 'PUT') {
				put = route.request().postDataJSON()
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						id: 'g1',
						actorId: agentId,
						integrationRef: REF,
						mode: 'read',
						tools: [],
					}),
				})
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					grants: [{ id: 'g1', actorId: agentId, integrationRef: REF, mode: 'all', tools: [] }],
					tools: { [REF]: TOOLS },
				}),
			})
		})

		const agent = await gotoAgent(page, account)
		agentId = agent.id
		await page.reload()

		await page.getByRole('button', { name: 'Change' }).click()
		await page
			.getByRole('dialog')
			.getByRole('radio', { name: /Read only/ })
			.click()
		await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()

		await expect.poll(() => put?.mode, { timeout: 10_000 }).toBe('read')
	})

	test('picks individual tools, grouped by whether they write', async ({ page, account }) => {
		let put: { mode?: string; tools?: string[] } | null = null
		let agentId = ''
		await page.route('**/api/tool-grants**', async (route) => {
			if (route.request().method() === 'PUT') {
				put = route.request().postDataJSON()
				return route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						id: 'g1',
						actorId: agentId,
						integrationRef: REF,
						mode: 'custom',
						tools: ['get_issue'],
					}),
				})
			}
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					grants: [{ id: 'g1', actorId: agentId, integrationRef: REF, mode: 'all', tools: [] }],
					tools: { [REF]: TOOLS },
				}),
			})
		})

		const agent = await gotoAgent(page, account)
		agentId = agent.id
		await page.reload()

		await page.getByRole('button', { name: 'Change' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('radio', { name: /Choose tools/ }).click()

		// The grouping is the honest part: a tool the provider did not classify is
		// shown as such rather than being guessed into Read.
		await expect(dialog.getByText('Unclassified')).toBeVisible()
		await expect(dialog.getByText(/didn't say whether these write/)).toBeVisible()

		await dialog.getByText('get_issue').click()
		await dialog.getByRole('button', { name: 'Save' }).click()

		await expect.poll(() => put?.mode, { timeout: 10_000 }).toBe('custom')
		expect(put?.tools).toContain('get_issue')
	})

	test('cannot save an empty selection', async ({ page, account }) => {
		// An empty custom grant admits nothing and would present as granted-but-broken.
		await stubGrants(page, {
			grants: [{ id: 'g1', actorId: 'x', integrationRef: REF, mode: 'custom', tools: [] }],
		})
		let agentId = ''
		await page.route('**/api/tool-grants**', async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					grants: [{ id: 'g1', actorId: agentId, integrationRef: REF, mode: 'all', tools: [] }],
					tools: { [REF]: TOOLS },
				}),
			})
		})

		const agent = await gotoAgent(page, account)
		agentId = agent.id
		await page.reload()

		await page.getByRole('button', { name: 'Change' }).click()
		const dialog = page.getByRole('dialog')
		await dialog.getByRole('radio', { name: /Choose tools/ }).click()

		await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
	})

	test('renders in light and dark', async ({ page, account }) => {
		let agentId = ''
		await page.route('**/api/tool-grants**', async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					grants: [{ id: 'g1', actorId: agentId, integrationRef: REF, mode: 'read', tools: [] }],
					tools: { [REF]: TOOLS },
				}),
			})
		})

		const agent = await gotoAgent(page, account)
		agentId = agent.id

		for (const colorScheme of ['light', 'dark'] as const) {
			await page.emulateMedia({ colorScheme })
			await page.reload()
			await expect(page.getByRole('heading', { name: 'Integration access' })).toBeVisible({
				timeout: 10_000,
			})
			await expect(page.getByText(/Read only/)).toBeVisible()
		}
	})
})
