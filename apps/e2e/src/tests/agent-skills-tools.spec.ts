import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — Skills and Tools sections', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders both sections with counts, names, origins, scopes and their edit controls @ ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const agent = await account.api.createAgentActor('Sam Skillstool')
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)

			// Seed one personal skill so the Skills section has a named row with
			// an origin ("Personal") plus a non-zero count. Personal skills persist
			// through agentStorage (S3/SeaweedFS), which isn't provisioned in the
			// verify-e2e CI job — same constraint as skills-folder-upload.spec.ts —
			// so the seed and its assertion only run locally.
			const canSeedSkills = !process.env.CI
			if (canSeedSkills) {
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
			}

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
			// `exact` matters: with no seeded skill the section renders "No personal
			// skills yet." / "No workspace skills yet.", which a substring match would
			// also hit — a strict-mode violation on the CI run (no S3 → no seed).
			await expect(skills.getByText('Personal', { exact: true })).toBeVisible()
			await expect(skills.getByText('Workspace', { exact: true })).toBeVisible()
			if (canSeedSkills) {
				await expect(skills.getByText('deploy', { exact: true })).toBeVisible()
			}
			// v2 has no Manage switch — the add controls are on the page at rest
			// (mockup 2448–2467).
			await expect(skills.getByRole('button', { name: 'Manage' })).toHaveCount(0)
			await expect(skills.getByRole('button', { name: /Add Skill/i })).toBeVisible()
			await expect(skills.getByRole('button', { name: /Import SKILL/i })).toBeVisible()

			// Tools section — labelled region, count, each tool's name and its scope.
			const tools = page.getByRole('region', { name: 'Tools' })
			await expect(tools).toBeVisible()
			await expect(tools.getByLabel('2 tools attached')).toBeVisible()
			// Same `exact` reason as the origin labels above: each server's name is a
			// substring of the transport line rendered directly beneath it
			// ("linear" ⊂ the URL, "github" ⊂ the npx command).
			await expect(tools.getByText('linear', { exact: true })).toBeVisible()
			await expect(tools.getByText('github', { exact: true })).toBeVisible()
			await expect(tools.getByText('https://mcp.linear.app/mcp')).toBeVisible()
			await expect(tools.getByText('npx -y @modelcontextprotocol/server-github')).toBeVisible()
			await expect(tools.getByRole('button', { name: 'Manage' })).toHaveCount(0)

			// The per-row and add controls are reachable without a mode switch
			// (mockup 2470–2488) — and reachable on touch, not hover-revealed.
			await expect(tools.getByRole('button', { name: /Add Server/i })).toBeVisible()
			await expect(tools.getByRole('button', { name: /Import \.mcp\.json/i })).toBeVisible()
			await expect(tools.getByRole('button', { name: 'Delete server' }).first()).toBeVisible()

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
