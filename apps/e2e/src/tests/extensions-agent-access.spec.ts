import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * Agent access on a custom extension (bring-your-own integrations): default
 * deny, per-tool grants, and the read-only mirror on the agent page. The
 * surface sits behind the byo-extensions-ui flag, so the specs use the
 * client-side test override. The backend is real: the extension, the agent and
 * the grants all go through /api. The Attempted chip needs a blocked_tool_calls
 * row, which only the guard wrapper writes; it is covered in the component
 * tests and the integration test instead.
 */

const TOOLS = [
	{ name: 'get_transcript', kind: 'read' },
	{ name: 'list_transcripts', kind: 'read' },
	{ name: 'bookmark_meeting', kind: 'write' },
]

async function enableFlag(page: Page) {
	await page.addInitScript(() => {
		localStorage.setItem('ff:byo-extensions-ui', 'on')
	})
}

async function seedExtension(page: Page, apiKey: string, workspaceId: string, name: string) {
	const res = await page.request.post('/api/extensions', {
		headers: { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId },
		data: {
			slug: `fireflies-${Date.now()}`,
			name,
			mcp_config: {
				envKey: 'FIREFLIES_TOKEN',
				server: { type: 'stdio', command: 'npx', args: ['mcp-remote', 'https://v.example'] },
				autoInject: true,
				credentialProvider: 'extension:fireflies',
				tools: TOOLS,
			},
		},
	})
	expect(res.status()).toBe(201)
	return ((await res.json()) as { id: string }).id
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`extension agent access at ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('grants an agent read tools by default, keeps write tools opt-in, and mirrors on the agent page', async ({
			page,
			account,
		}) => {
			await enableFlag(page)
			const extName = `Fireflies ${Date.now()}`
			const agent = await account.api.createAgentActor(`Analyst ${Date.now()}`, account.workspaceId)
			const extId = await seedExtension(page, account.apiKey, account.workspaceId, extName)

			await page.goto(`/${account.workspaceId}/settings/extensions/${extId}`)
			await expect(page.getByRole('heading', { name: 'Agent access' })).toBeVisible()
			await expect(page.getByText('Default deny', { exact: true })).toBeVisible()

			// Default deny: the agent is listed with its toggle off.
			const toggle = page.getByRole('switch', { name: `${agent.name} can call ${extName} tools` })
			await expect(toggle).toHaveAttribute('aria-checked', 'false')

			// Switching it on opens the grant modal: read pre-checked, write opt-in.
			await toggle.click()
			const dialog = page.getByRole('dialog')
			await expect(dialog.getByText(`Grant ${agent.name} → ${extName}`)).toBeVisible()
			await expect(dialog.getByRole('checkbox', { name: 'get_transcript' })).toBeChecked()
			await expect(dialog.getByRole('checkbox', { name: 'list_transcripts' })).toBeChecked()
			await expect(dialog.getByRole('checkbox', { name: 'bookmark_meeting' })).not.toBeChecked()
			await dialog.getByRole('button', { name: 'Grant 2 tools' }).click()
			await expect(dialog).toBeHidden()

			// The grant is stored: the agent reads Allowed and the Access step is done.
			await expect(page.getByText('Granted 2 of 3 tools')).toBeVisible()
			await expect(toggle).toHaveAttribute('aria-checked', 'true')
			await page.reload()
			await expect(page.getByText('Granted 2 of 3 tools')).toBeVisible()
			await expect(page.getByRole('region', { name: 'Setup progress' })).toContainText(
				/Access\s*done/,
			)

			// The agent page shows the same grant read-only and links back.
			await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
			await expect(
				page.getByRole('heading', { name: `Extensions ${agent.name} can call` }),
			).toBeVisible()
			await page.getByRole('link', { name: new RegExp(extName) }).click()
			await expect(page).toHaveURL(new RegExp(`/settings/extensions/${extId}$`))

			// Switching the agent off removes every grant.
			await page.getByRole('switch', { name: `${agent.name} can call ${extName} tools` }).click()
			await expect(page.getByText('No access · default deny').first()).toBeVisible()
			await expect(page.getByText('Granted 2 of 3 tools')).toHaveCount(0)
		})
	})
}

test.describe('extension agent access flag', () => {
	test('hides the mirror on the agent page while the flag is off', async ({ page, account }) => {
		await page.addInitScript(() => {
			localStorage.setItem('ff:byo-extensions-ui', 'off')
		})
		const agent = await account.api.createAgentActor(`Analyst ${Date.now()}`, account.workspaceId)
		await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
		await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible()
		await expect(page.getByRole('heading', { name: /Extensions .* can call/ })).toHaveCount(0)
	})
})
