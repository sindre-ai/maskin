import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — Skills and Tools sections', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders both sections with counts, names, origins, glyphs, scopes and Manage @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Sam Skillstool')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// Seed one personal skill so the Skills section has a named row with
			// an origin ("Personal") plus a non-zero count.
			const skillRes = await fetch(`http://localhost:5173/api/actors/${agent.id}/skills/deploy`, {
				method: 'PUT',
				headers: {
					'Content-Type': 'application/json',
					Authorization: `Bearer ${account.apiKey}`,
					'X-Workspace-Id': account.workspaceId,
				},
				body: JSON.stringify({
					description: 'Ship a build to prod',
					content: '# deploy\nShip carefully.',
				}),
			})
			expect(skillRes.ok).toBe(true)

			// Seed two MCP servers so the Tools section has both glyphs and both scopes.
			await account.api.updateActor(agent.id, {
				tools: {
					mcpServers: {
						linear: {
							type: 'http',
							url: 'https://mcp.linear.app/mcp',
							headers: {},
						},
						github: {
							type: 'stdio',
							command: 'npx',
							args: ['-y', '@modelcontextprotocol/server-github'],
							env: {},
						},
					},
				},
			})

			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)

			// Skills section — labelled region, count, both origin groups and the seeded name.
			const skills = page.getByRole('region', { name: 'Skills' })
			await expect(skills).toBeVisible({ timeout: 10_000 })
			await expect(skills.getByLabel(/skills? attached/i)).toBeVisible()
			await expect(skills.getByText('Personal')).toBeVisible()
			await expect(skills.getByText('Workspace')).toBeVisible()
			await expect(skills.getByText('deploy')).toBeVisible()
			await expect(skills.getByRole('button', { name: 'Manage' })).toBeVisible()

			// Tools section — labelled region, count, each tool's name and its scope.
			const tools = page.getByRole('region', { name: 'Tools' })
			await expect(tools).toBeVisible()
			await expect(tools.getByLabel('2 tools attached')).toBeVisible()
			await expect(tools.getByText('linear')).toBeVisible()
			await expect(tools.getByText('github')).toBeVisible()
			await expect(tools.getByText('https://mcp.linear.app/mcp')).toBeVisible()
			await expect(tools.getByText('npx -y @modelcontextprotocol/server-github')).toBeVisible()
			await expect(tools.getByRole('button', { name: 'Manage' })).toBeVisible()

			// Manage flips the section into an editable state (aria-pressed toggles),
			// then Done flips it back — proves the affordance is wired without
			// leaving edit UI on the read-only surface between clicks.
			const manageTools = tools.getByRole('button', { name: 'Manage' })
			await manageTools.click()
			await expect(tools.getByRole('button', { name: 'Done' })).toHaveAttribute(
				'aria-pressed',
				'true',
			)
			await tools.getByRole('button', { name: 'Done' }).click()
			await expect(tools.getByRole('button', { name: 'Manage' })).toBeVisible()

			// Reload preserves the surface — proves this isn't a mount-only render.
			await page.reload()
			await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible()
			await expect(page.getByRole('region', { name: 'Tools' })).toBeVisible()

			// Both light and dark schemes render both sections.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible()
				await expect(page.getByRole('region', { name: 'Tools' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
