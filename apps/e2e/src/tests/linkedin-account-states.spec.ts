import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// T4: exercise the full LinkedIn account state UI on the SDR agent detail page.
// Stubs `/api/linkedin/account` so we can drive every lifecycle state without
// seeding real DB rows in each of the six shapes. Runs at 375/768/1024 so the
// mobile-collapse behaviour is asserted at the same time.

type StubState =
	| 'not-connected'
	| 'handoff'
	| 'syncing'
	| 'warm_up'
	| 'healthy'
	| 'reconnect'
	| 'restricted'

interface StubAccount {
	id: string
	workspaceId: string
	state: Exclude<StubState, 'not-connected'>
	unipileAccountId: string | null
	sendingAsName: string | null
	sendingAsProviderId: string | null
	connectedAt: string | null
	createdAt: string | null
	updatedAt: string | null
	pacing: {
		dailyCap: number
		dailySent: number
		weeklyCap: number
		weeklySent: number
		warmup: { day: number; total: number } | null
	}
	acceptanceRate: number | null
}

function buildStubAccount(
	workspaceId: string,
	state: Exclude<StubState, 'not-connected'>,
): StubAccount {
	const base: StubAccount = {
		id: 'acc-stub',
		workspaceId,
		state,
		unipileAccountId: 'unipile-stub',
		sendingAsName: 'Sebastian Bakke',
		sendingAsProviderId: 'urn:li:1',
		connectedAt: new Date('2026-07-10T12:00:00.000Z').toISOString(),
		createdAt: null,
		updatedAt: null,
		pacing: { dailyCap: 0, dailySent: 0, weeklyCap: 0, weeklySent: 0, warmup: null },
		acceptanceRate: null,
	}
	switch (state) {
		case 'handoff':
			return { ...base }
		case 'syncing':
			return { ...base }
		case 'warm_up':
			return {
				...base,
				pacing: {
					dailyCap: 5,
					dailySent: 2,
					weeklyCap: 25,
					weeklySent: 9,
					warmup: { day: 3, total: 14 },
				},
			}
		case 'healthy':
			return {
				...base,
				pacing: {
					dailyCap: 20,
					dailySent: 4,
					weeklyCap: 80,
					weeklySent: 18,
					warmup: null,
				},
				acceptanceRate: 0.62,
			}
		case 'reconnect':
			return {
				...base,
				pacing: { dailyCap: 0, dailySent: 0, weeklyCap: 0, weeklySent: 18, warmup: null },
				acceptanceRate: 0.62,
			}
		case 'restricted':
			return { ...base, acceptanceRate: 0.62 }
	}
}

test.describe('LinkedIn account state UI on agent detail', () => {
	for (const viewport of SHIP_GATE_VIEWPORTS) {
		test(`walks every state at ${viewport.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: viewport.width, height: viewport.height })

			const agentRes = await page.request.post('http://localhost:5173/api/actors', {
				headers: {
					'content-type': 'application/json',
					Authorization: `Bearer ${account.apiKey}`,
				},
				// tools.capabilities: ['linkedin'] is what mounts the LinkedIn UI on the
				// agent detail page — non-SDR agents omit it and see no LinkedIn UI.
				data: {
					type: 'agent',
					name: `LinkedIn State Agent ${Date.now()}`,
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

			let currentState: StubState = 'not-connected'
			await page.route('**/api/linkedin/account', async (route) => {
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body:
						currentState === 'not-connected'
							? 'null'
							: JSON.stringify(buildStubAccount(account.workspaceId, currentState)),
				})
			})

			async function setState(next: StubState) {
				currentState = next
				await page.goto(`/${account.workspaceId}/agents/${agent.id}`)
				// Wait for the LinkedIn account query to settle.
				await page.waitForResponse(
					(res) => res.url().endsWith('/api/linkedin/account') && res.status() === 200,
				)
			}

			// Empty state: pill + Channels row CTA.
			await setState('not-connected')
			const main = page.locator('main')
			await expect(main.getByText(/needs linkedin/i)).toBeVisible()
			await expect(main.getByRole('button', { name: /connect linkedin/i })).toBeVisible()

			// Handoff: reopen CTA + spinner pill.
			await setState('handoff')
			await expect(main.getByRole('button', { name: /reopen unipile/i })).toBeVisible()

			// Syncing: info callout, sync spinner button disabled.
			await setState('syncing')
			await expect(main.getByText(/first-sync in progress/i)).toBeVisible()

			// Warm-up: day counter + warm-up caps.
			await setState('warm_up')
			await expect(main.getByText(/warming up · day 3 of 14/i).first()).toBeVisible()
			await expect(main.getByText('2 / 5')).toBeVisible()
			await expect(main.getByText('9 / 25')).toBeVisible()

			// Healthy: sending-as identity, pacing counters, acceptance rate.
			await setState('healthy')
			await expect(main.getByText('Sebastian Bakke').first()).toBeVisible()
			await expect(main.getByText('4 / 20')).toBeVisible()
			await expect(main.getByText('18 / 80')).toBeVisible()
			await expect(main.getByText(/acceptance 62%/i)).toBeVisible()

			// Reconnect: Reconnect CTA present + Run button disabled.
			await setState('reconnect')
			await expect(main.getByRole('button', { name: /^reconnect$/i })).toBeVisible()
			await expect(page.getByRole('button', { name: /^run$/i })).toBeDisabled()

			// Restricted: no reconnect CTA, recovery guide link, Run disabled.
			await setState('restricted')
			await expect(main.getByRole('link', { name: /recovery guide/i })).toBeVisible()
			await expect(main.getByRole('button', { name: /^reconnect$/i })).toHaveCount(0)
			await expect(page.getByRole('button', { name: /^run$/i })).toBeDisabled()
		})
	}
})
