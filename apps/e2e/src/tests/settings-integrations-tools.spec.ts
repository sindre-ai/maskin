import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Tools on Settings → Integrations: Maskin is always on, and a custom MCP server is added once
 * and shared with chosen agents. Runs against the real stack (no stubs): the server and its
 * grants are real rows, so a reload proves the change persisted and the agent page proves the
 * same access shows up there.
 */

// A server that runs in the container: Maskin cannot see its calls, so it is on or off.
const SERVER = { type: 'stdio', command: 'npx', args: ['-y', 'docs-mcp'] }
// An HTTP server at a public address: Maskin sits in front of it, so it has levels.
const GATED = { type: 'http', url: 'https://tools.example.com/mcp', headers: {} }

for (const vp of SHIP_GATE_VIEWPORTS) {
	test(`Maskin is locked on; a custom server is shared with an agent @ ${vp.label}`, async ({
		page,
		account,
	}) => {
		await page.setViewportSize({ width: vp.width, height: vp.height })
		const agent = await account.api.createAgentActor('Docs Reader', account.workspaceId)
		await account.api.createCustomMcpServer(account.workspaceId, 'Docs search', SERVER)

		await page.goto(`/${account.workspaceId}/settings/integrations`)
		const tools = page.getByRole('region', { name: 'Custom tools' })
		await expect(tools).toBeVisible({ timeout: 15_000 })

		// Maskin: on for every agent, read & write, nothing to switch.
		await expect(tools.getByText('Maskin', { exact: true })).toBeVisible()
		await expect(tools.getByText(/Read & write · always on/)).toBeVisible()

		// The server we added, with where it points and no secrets.
		await expect(tools.getByText('Docs search', { exact: true })).toBeVisible()
		await expect(tools.getByText(/stdio · npx -y docs-mcp/)).toBeVisible()

		// Nobody has it yet; give it to one agent.
		const agents = tools.getByRole('button', { name: /Agents/ })
		await expect(agents).toContainText('No agents use it yet')
		await agents.click()
		const toggle = tools.getByRole('switch', { name: 'Docs search for Docs Reader' })
		await expect(toggle).not.toBeChecked()
		await toggle.click()
		await expect(toggle).toBeChecked()
		await expect(agents).toContainText(/1 of \d+ agents/)

		// It stuck: a reload shows the same.
		await page.reload()
		await tools.getByRole('button', { name: /Agents/ }).click()
		await expect(
			page.getByRole('region', { name: 'Custom tools' }).getByRole('switch', {
				name: 'Docs search for Docs Reader',
			}),
		).toBeChecked()

		// And the agent's own page shows the same, with Maskin locked above it.
		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		const access = page.getByRole('region', { name: 'Access' })
		await expect(access).toBeVisible({ timeout: 15_000 })
		await expect(access.getByRole('switch', { name: 'Docs search for this agent' })).toBeChecked()
		await expect(access.getByRole('list', { name: 'Tools' }).getByText('Maskin')).toBeVisible()

		// Switching it off here is the same grant, so the Integrations page follows.
		await access.getByRole('switch', { name: 'Docs search for this agent' }).click()
		await expect(
			access.getByRole('switch', { name: 'Docs search for this agent' }),
		).not.toBeChecked()
		await page.goto(`/${account.workspaceId}/settings/integrations`)
		await expect(
			page.getByRole('region', { name: 'Custom tools' }).getByRole('button', { name: /Agents/ }),
		).toContainText('No agents use it yet')

		// Nothing spills out sideways.
		const overflow = await page.evaluate(
			() => document.documentElement.scrollWidth > window.innerWidth,
		)
		expect(overflow).toBe(false)
	})
}

test('an HTTP server has Read, Read & write and No access like a built-in integration', async ({
	page,
	account,
}) => {
	const agent = await account.api.createAgentActor('Docs Reader', account.workspaceId)
	await account.api.createCustomMcpServer(account.workspaceId, 'Docs API', GATED)
	await page.goto(`/${account.workspaceId}/settings/integrations`)
	const tools = page.getByRole('region', { name: 'Custom tools' })
	await expect(tools).toBeVisible({ timeout: 15_000 })
	await tools.getByRole('button', { name: /Agent access/ }).click()
	await tools.getByRole('combobox', { name: 'Add an agent' }).click()
	await page.getByRole('option', { name: 'Docs Reader' }).click()
	const level = tools.getByRole('combobox', { name: 'Access for Docs Reader' })
	// A server nobody has yet starts an added agent at Read.
	await expect(level).toContainText('Read')
	await level.click()
	await page.getByRole('option', { name: 'Read & write' }).click()
	await expect(level).toContainText('Read & write')
	await level.click()
	await page.getByRole('option', { name: 'Read', exact: true }).click()
	await expect(level).toContainText('Read')

	// The agent's own page shows the same level, with the same options.
	await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
	const row = page.getByRole('combobox', { name: 'Access to Docs API' })
	await expect(row).toContainText('Read', { timeout: 15_000 })
	await row.click()
	await expect(page.getByRole('option', { name: 'Read & write' })).toBeVisible()
	await expect(page.getByRole('option', { name: 'No access', exact: true })).toBeVisible()
})

test('add a server from the form, then remove it', async ({ page, account }) => {
	await page.goto(`/${account.workspaceId}/settings/integrations`)
	const tools = page.getByRole('region', { name: 'Custom tools' })
	await expect(tools).toBeVisible({ timeout: 15_000 })

	await tools.getByRole('button', { name: /Add server/ }).click()
	await tools.getByLabel('Name').fill('Filesystem')
	await tools.getByLabel('Command').fill('npx')
	await tools
		.getByLabel('Args (comma-separated)')
		.fill('-y, @modelcontextprotocol/server-filesystem')
	await tools.getByRole('button', { name: 'Save' }).click()
	await expect(tools.getByText('Filesystem', { exact: true })).toBeVisible()
	await expect(
		tools.getByText(/stdio · npx -y @modelcontextprotocol\/server-filesystem/),
	).toBeVisible()

	// A second server under the same name is refused, in the form.
	await tools.getByRole('button', { name: /Add server/ }).click()
	await tools.getByLabel('Name').fill('filesystem')
	await tools.getByLabel('Command').fill('npx')
	await tools.getByRole('button', { name: 'Save' }).click()
	await expect(tools.getByText('A tool server with that name already exists')).toBeVisible()
	await tools.getByRole('button', { name: 'Cancel' }).click()

	await tools.getByRole('button', { name: 'Remove Filesystem' }).click()
	await tools.getByRole('button', { name: 'Remove', exact: true }).click()
	await expect(tools.getByText('Filesystem', { exact: true })).toHaveCount(0)
})

test('the Tools section reads in light and dark', async ({ page, account }) => {
	await account.api.createCustomMcpServer(account.workspaceId, 'Docs search', SERVER)
	await page.goto(`/${account.workspaceId}/settings/integrations`)
	for (const scheme of ['light', 'dark'] as const) {
		await page.emulateMedia({ colorScheme: scheme })
		const tools = page.getByRole('region', { name: 'Custom tools' })
		await expect(tools.getByText('Maskin', { exact: true })).toBeVisible()
		await expect(tools.getByText('Docs search', { exact: true })).toBeVisible()
		await expect(tools.getByRole('button', { name: /Add server/ })).toBeVisible()
	}
})

test('a header can use a saved Keychain credential instead of a pasted secret', async ({
	page,
	account,
}) => {
	const res = await fetch('http://localhost:5173/api/integrations/byo-apikey', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${account.apiKey}`,
			'X-Workspace-Id': account.workspaceId,
		},
		body: JSON.stringify({ displayName: 'Stripe', rawSecret: 'sk-live-e2e-secret' }),
	})
	expect(res.ok).toBe(true)

	await page.goto(`/${account.workspaceId}/settings/integrations`)
	const tools = page.getByRole('region', { name: 'Custom tools' })
	await expect(tools).toBeVisible({ timeout: 15_000 })
	await tools.getByRole('button', { name: /Add server/ }).click()
	await tools.getByLabel('Name').fill('Billing')
	await tools.getByRole('combobox', { name: 'Transport' }).click()
	await page.getByRole('option', { name: 'HTTP' }).click()
	await tools.getByLabel('URL').fill('https://tools.example.com/mcp')
	await tools.getByRole('button', { name: 'Add', exact: true }).click()
	await tools.getByLabel('Headers name').fill('Authorization')
	await tools.getByLabel('Headers value').fill('Bearer ')
	await tools.getByRole('combobox', { name: /saved credential for headers Authorization/i }).click()
	await page.getByRole('option', { name: 'Stripe' }).click()
	await expect(tools.getByLabel('Headers value')).toHaveValue(
		'Bearer ${KEYCHAIN_BYO_APIKEY_STRIPE}',
	)
	await tools.getByRole('button', { name: 'Save' }).click()
	await expect(tools.getByText('Billing', { exact: true })).toBeVisible()

	// Reopened, it still names the credential (not a mask), and the secret is nowhere on the page.
	await tools.getByRole('button', { name: 'Edit Billing' }).click()
	await expect(tools.getByLabel('Headers value')).toHaveValue(
		'Bearer ${KEYCHAIN_BYO_APIKEY_STRIPE}',
	)
	await expect(page.locator('body')).not.toContainText('sk-live-e2e-secret')

	// A credential that is not in the Keychain is refused, in the form.
	await tools.getByLabel('Headers value').fill('Bearer ${KEYCHAIN_BYO_APIKEY_NOPE}')
	await tools.getByRole('button', { name: 'Save' }).click()
	await expect(
		tools.getByText('No saved credential matches KEYCHAIN_BYO_APIKEY_NOPE'),
	).toBeVisible()
})
