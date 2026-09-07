import { expect, test } from '../fixtures/auth.fixture'

// Slack channel id we pretend the bot was kicked from. Not a real channel —
// the banner falls back to rendering the raw id when useSlackConversations
// returns no match (i.e. no live Slack integration seeded), which is fine for
// this assertion.
const KICKED_CHANNEL_ID = 'C_E2E_KICKED'

test.describe('Slack trigger auto-pause banner', () => {
	test('renders the red auto-paused banner + Resume button when metadata.auto_paused is present', async ({
		page,
		account,
	}) => {
		const agent = await account.api.createAgentActor('Relay')
		await account.api.addWorkspaceMember(account.workspaceId, agent.id)
		const trigger = await account.api.createTrigger(account.workspaceId, {
			name: 'Slack channel triage',
			type: 'event',
			action_prompt: 'Triage the incoming Slack message',
			target_actor_id: agent.id,
			config: {
				entity_type: 'slack.channel_message',
				action: 'created',
				conditions: [{ field: 'event.channel', operator: 'in', value: [KICKED_CHANNEL_ID] }],
			},
		})

		// Intercept the trigger detail GET and inject the auto_paused stamp the
		// backend handler would have written. Handler behaviour itself is unit-
		// tested in slack-member-left.test.ts; this test proves the UI surface
		// reads the stamp and flips the banner shape end-to-end through the
		// router + form.
		await page.route(`**/api/triggers/${trigger.id}`, async (route) => {
			if (route.request().method() !== 'GET') return route.fallback()
			const response = await route.fetch()
			const body = (await response.json()) as Record<string, unknown>
			const existingMetadata =
				(body.metadata as Record<string, unknown> | null | undefined) ?? {}
			await route.fulfill({
				response,
				json: {
					...body,
					enabled: false,
					metadata: {
						...existingMetadata,
						auto_paused: {
							reason: 'slack_member_left',
							channel_id: KICKED_CHANNEL_ID,
							paused_at: '2026-08-30T14:00:00Z',
							previous_enabled: true,
						},
					},
				},
			})
		})

		await page.goto(`/${account.workspaceId}/triggers/${trigger.id}`)

		const banner = page.getByTestId('slack-trigger-setup-status')
		await expect(banner).toBeVisible({ timeout: 10_000 })
		await expect(banner).toHaveAttribute('data-state', 'auto-paused')
		// The channel name resolves to the raw id here because no
		// useSlackConversations cache is warm — the copy still renders and
		// carries the `#`-prefix contract from `slackMemberLeftCopy`.
		await expect(banner).toContainText(
			'Auto-paused — Maskin was removed from #',
		)
		await expect(banner).toContainText('Reinvite the app in Slack, then resume the trigger.')
		await expect(page.getByTestId('slack-auto-pause-resume')).toBeVisible()
	})
})
