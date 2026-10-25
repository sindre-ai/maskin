import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

test.describe('Agent detail — Skills and Access sections', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders both sections, with Maskin locked on @ ${vp.label}`, async ({
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
			// No Manage switch on either section: v2 made both editable at rest
			// (mockup 2448–2467), which is what the per-row controls asserted
			// below depend on.
			await expect(skills.getByRole('button', { name: 'Manage' })).toHaveCount(0)

			// Access — the Maskin MCP is on every agent and cannot be switched.
			const tools = page.getByRole('region', { name: 'Access' })
			await expect(tools).toBeVisible()
			const maskin = tools.getByRole('list', { name: 'Tools' })
			await expect(maskin.getByText('Maskin', { exact: true })).toBeVisible()
			await expect(maskin.getByText('Read & write')).toBeVisible()
			await expect(maskin.getByRole('switch')).toHaveCount(0)
			// The old per-agent server editor is gone: servers are managed under Integrations.
			await expect(tools.getByRole('button', { name: /Add Server/i })).toHaveCount(0)

			// Reload preserves the surface — proves this isn't a mount-only render.
			await page.reload()
			await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible()
			await expect(page.getByRole('region', { name: 'Access' })).toBeVisible()

			// Both light and dark schemes render both sections.
			for (const scheme of ['light', 'dark'] as const) {
				await page.emulateMedia({ colorScheme: scheme })
				await expect(page.getByRole('region', { name: 'Skills' })).toBeVisible()
				await expect(page.getByRole('region', { name: 'Access' })).toBeVisible()
			}
			await page.emulateMedia({ colorScheme: 'light' })
		})
	}
})
