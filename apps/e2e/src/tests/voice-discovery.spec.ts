import { expect, test } from '../fixtures/auth.fixture'

// Voice v1 Task 4 discovery surfaces (bet/16bd0042-voice-v1). This spec
// covers the three surfaces that stand alone on top of the existing agents
// index — the Voice-enabled badge, the Voice filter chip, and the empty
// state — plus the agent-settings Voice mode toggle. The remaining Task 4
// surfaces (row-level Call, thread-header Call, error dialog states,
// session-end backend, cost + PostHog voice_session_ended emit path) sit on
// top of Task 1 / Task 2 code that has not landed on the bet branch yet and
// land in a follow-up commit once those dependencies clear.
//
// The `ff:voice-mode-v1` localStorage override (see feature-flags.ts) beats
// the server response so the spec can flip both sides of the flag boundary
// without provisioning a second actor.

test.describe('Voice discovery — badge, filter chip, empty state', () => {
	test('agents list shows a Voice-enabled badge for voice-enabled agents only', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)

		const text = await account.api.createAgentActor('Tia Text')
		await account.api.addWorkspaceMember(account.workspaceId, text.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
		})

		await page.goto(`/${account.workspaceId}/agents`)

		const voiceRow = page.getByRole('link').filter({ hasText: 'Vera Voice' })
		await expect(voiceRow).toBeVisible({ timeout: 10_000 })
		await expect(voiceRow.getByLabel('Voice-enabled agent')).toBeVisible()

		const textRow = page.getByRole('link').filter({ hasText: 'Tia Text' })
		await expect(textRow).toBeVisible()
		await expect(textRow.getByLabel('Voice-enabled agent')).toHaveCount(0)
	})

	test('Voice filter chip narrows the list to voice-enabled agents', async ({ page, account }) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)
		await account.api.setActorVoiceMode(account.workspaceId, voice.id, true)

		const text = await account.api.createAgentActor('Tia Text')
		await account.api.addWorkspaceMember(account.workspaceId, text.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
		})

		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByRole('link').filter({ hasText: 'Vera Voice' })).toBeVisible({
			timeout: 10_000,
		})

		const voiceChip = page.getByRole('button', { name: /^Voice \(/ })
		await expect(voiceChip).toBeVisible()

		await voiceChip.click()

		await expect(page.getByRole('link').filter({ hasText: 'Vera Voice' })).toBeVisible()
		await expect(page.getByRole('link').filter({ hasText: 'Tia Text' })).toHaveCount(0)
	})

	test('empty state shows verbatim copy when no agent is voice-enabled', async ({
		page,
		account,
	}) => {
		const text = await account.api.createAgentActor('Tia Text')
		await account.api.addWorkspaceMember(account.workspaceId, text.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
		})

		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByRole('link').filter({ hasText: 'Tia Text' })).toBeVisible({
			timeout: 10_000,
		})

		const voiceChip = page.getByRole('button', { name: /^Voice \(/ })
		await voiceChip.click()

		// Verbatim heading per SPEC §Copy — a string not listed there is a bug.
		await expect(page.getByText('No voice-enabled agents yet', { exact: true })).toBeVisible()
	})

	test('Voice chip is hidden when the flag is off', async ({ page, account }) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'off')
		})

		await page.goto(`/${account.workspaceId}/agents`)
		await expect(page.getByRole('link').filter({ hasText: 'Vera Voice' })).toBeVisible({
			timeout: 10_000,
		})

		await expect(page.getByRole('button', { name: /^Voice \(/ })).toHaveCount(0)
	})
})

test.describe('Voice mode toggle — agent settings', () => {
	test('toggle flips actors.metadata.voice_enabled and re-renders the badge', async ({
		page,
		account,
	}) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'on')
		})

		await page.goto(`/${account.workspaceId}/agents/${voice.id}`)

		// Verbatim help copy per SPEC §Copy.
		const helpCopy = 'Let workspace members hold a live voice call with this agent.'
		await expect(page.getByText(helpCopy, { exact: true })).toBeVisible({ timeout: 10_000 })

		const toggle = page.getByRole('switch', { name: 'Enable voice calls with this agent' })
		await expect(toggle).toBeVisible()
		await expect(toggle).toHaveAttribute('aria-checked', 'false')

		await toggle.click()
		await expect(toggle).toHaveAttribute('aria-checked', 'true')

		// Round-trip through the list surface so we're asserting the projection
		// off metadata, not just the local state of the switch.
		await page.goto(`/${account.workspaceId}/agents`)
		const row = page.getByRole('link').filter({ hasText: 'Vera Voice' })
		await expect(row).toBeVisible({ timeout: 10_000 })
		await expect(row.getByLabel('Voice-enabled agent')).toBeVisible()
	})

	test('Voice mode section is hidden when the flag is off', async ({ page, account }) => {
		const voice = await account.api.createAgentActor('Vera Voice')
		await account.api.addWorkspaceMember(account.workspaceId, voice.id)

		await page.addInitScript(() => {
			window.localStorage.setItem('ff:voice-mode-v1', 'off')
		})

		await page.goto(`/${account.workspaceId}/agents/${voice.id}`)
		await expect(page.getByRole('heading', { name: 'Vera Voice' })).toBeVisible({
			timeout: 10_000,
		})

		await expect(
			page.getByRole('switch', { name: 'Enable voice calls with this agent' }),
		).toHaveCount(0)
	})
})
