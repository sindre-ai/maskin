import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import type { TestAPI } from '../helpers/api.helper'
import { SHIP_GATE_VIEWPORTS, VIEWPORTS } from '../helpers/viewports'

/**
 * E2E coverage for the v2 Chats surface: the header filter menu, the grouped
 * conversation list, the two-row thread header (focus mode + close), the
 * participants popover, and the new-chat zero state.
 *
 * `chats.spec.ts` keeps the SSE/multi-party path; this spec owns the v2 shell.
 * Requires a live backend — every conversation is created through the real
 * `/api/conversations` routes via TestAPI.
 */

interface SeededChats {
	plain: string
	pinned: string
	archived: string
}

async function seedChats(api: TestAPI, workspaceId: string): Promise<SeededChats> {
	const stamp = Date.now()
	const plain = await api.createConversation(workspaceId, {
		title: `V2 Plain ${stamp}`,
		participant_actor_ids: [],
		initial_message: 'A plain conversation',
	})
	const pinned = await api.createConversation(workspaceId, {
		title: `V2 Pinned ${stamp}`,
		participant_actor_ids: [],
		initial_message: 'A pinned conversation',
	})
	const archived = await api.createConversation(workspaceId, {
		title: `V2 Archived ${stamp}`,
		participant_actor_ids: [],
		initial_message: 'An archived conversation',
	})
	await api.updateConversationMe(pinned.id, workspaceId, { pinned: true })
	await api.updateConversationMe(archived.id, workspaceId, { archived: true })
	return { plain: plain.title, pinned: pinned.title, archived: archived.title }
}

async function expectNoHorizontalOverflow(page: Page) {
	const overflow = await page.evaluate(() => {
		const el = document.scrollingElement
		return el ? el.scrollWidth - el.clientWidth : 0
	})
	// A one-pixel rounding slack; anything more is a real horizontal scrollbar.
	expect(overflow).toBeLessThanOrEqual(1)
}

async function openFilter(page: Page, label: string) {
	await page.getByRole('button', { name: /^Filter conversations/ }).click()
	await page.getByRole('menuitemradio', { name: label }).click()
}

test.describe('Chats v2 — filter menu', () => {
	test('filters the list, writes the URL, and survives a reload', async ({ page, account }) => {
		const chats = await seedChats(account.api, account.workspaceId)
		const list = page.getByTestId('conversation-list')

		await page.goto(`/${account.workspaceId}/chats`)
		await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })

		await openFilter(page, 'Pinned')
		await expect(page).toHaveURL(/[?&]filter=pinned/)
		await expect(list.getByText(chats.pinned)).toBeVisible()
		await expect(list.getByText(chats.plain)).toBeHidden()
		await expect(page.getByRole('button', { name: /^Filter conversations/ })).toContainText(
			'Pinned',
		)

		await page.reload()
		await expect(page).toHaveURL(/[?&]filter=pinned/)
		await expect(list.getByText(chats.pinned)).toBeVisible({ timeout: 15_000 })
		await expect(list.getByText(chats.plain)).toBeHidden()

		await openFilter(page, 'Archived')
		await expect(list.getByText(chats.archived)).toBeVisible({ timeout: 15_000 })
		await expect(list.getByText('Archived', { exact: true })).toBeVisible()

		await openFilter(page, 'All')
		await expect(page).not.toHaveURL(/filter=/)
		await expect(list.getByText(chats.plain)).toBeVisible()
	})

	test('shows the filter-specific empty copy when nothing matches', async ({ page, account }) => {
		await page.goto(`/${account.workspaceId}/chats`)
		await expect(page.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 })

		await openFilter(page, 'Archived')
		await expect(page.getByText('Nothing archived yet')).toBeVisible({ timeout: 15_000 })
		// A new chat is never archived — offering one here would send the reader
		// somewhere this filter still cannot show (mockup 542–544).
		await expect(page.getByRole('link', { name: 'Start a new one →' })).toHaveCount(0)
		await expect(page.getByRole('link', { name: 'View all chats →' })).toBeVisible()
	})
})

test.describe('Chats v2 — grouped list', () => {
	test('labels the group a fresh conversation lands in and closes the history', async ({
		page,
		account,
	}) => {
		const chats = await seedChats(account.api, account.workspaceId)
		const list = page.getByTestId('conversation-list')

		await page.goto(`/${account.workspaceId}/chats`)
		await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })
		// Pinned sorts above the dated groups.
		await expect(list.getByText('Pinned', { exact: true })).toBeVisible()
		await expect(list.getByText('Today', { exact: true })).toBeVisible()
		await expect(list.getByText(/That's the whole history/)).toBeVisible()
	})
})

test.describe('Chats v2 — layout', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`list, thread and back navigation work at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const chats = await seedChats(account.api, account.workspaceId)
			const list = page.getByTestId('conversation-list')

			await page.goto(`/${account.workspaceId}/chats`)
			await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })
			await expectNoHorizontalOverflow(page)

			// With nothing selected the list owns the whole content width.
			const listBox = await list.boundingBox()
			expect(listBox).not.toBeNull()

			await list.getByText(chats.plain).click()
			await expect(page.getByRole('heading', { name: chats.plain })).toBeVisible({
				timeout: 15_000,
			})
			await expectNoHorizontalOverflow(page)

			if (vp.width < 768) {
				// Mobile stacks: the list is replaced by the thread.
				await expect(list).toBeHidden()
				await page.getByRole('button', { name: 'Back to conversations' }).click()
			} else {
				// Both panes are visible side by side, and the list has narrowed.
				await expect(list).toBeVisible()
				const narrowed = await list.boundingBox()
				expect(narrowed?.width ?? 0).toBeLessThan(listBox?.width ?? 0)
				await page.getByRole('button', { name: 'Close conversation' }).click()
			}

			await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/chats/?(\\?.*)?$`))
			await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })
			await expectNoHorizontalOverflow(page)
		})
	}

	test('focus mode hides the list and restores it', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.tabletLandscape)
		const chats = await seedChats(account.api, account.workspaceId)
		const list = page.getByTestId('conversation-list')

		await page.goto(`/${account.workspaceId}/chats`)
		await list.getByText(chats.plain).click()
		await expect(page.getByRole('heading', { name: chats.plain })).toBeVisible({ timeout: 15_000 })
		await expect(list).toBeVisible()

		await page.getByRole('button', { name: 'Hide conversation list' }).click()
		await expect(page).toHaveURL(/[?&]wide=true/)
		await expect(list).toBeHidden()

		await page.getByRole('button', { name: 'Show conversation list' }).click()
		await expect(list).toBeVisible()
		await expect(page).not.toHaveURL(/wide=true/)
	})
})

test.describe('Chats v2 — participants popover', () => {
	for (const vp of [VIEWPORTS.mobile, VIEWPORTS.tabletLandscape]) {
		test(`every row is reachable without hover at ${vp.label}`, async ({ page, account }) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			const agent = await account.api.createAgentActor(`V2 Chat Agent ${Date.now()}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `V2 Participants ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'Who is in here?',
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			await page.getByRole('button', { name: /participants — manage/ }).click()

			await expect(page.getByText('In this chat')).toBeVisible({ timeout: 10_000 })
			await expect(page.getByText('Add someone — person or agent')).toBeVisible()
			await expect(page.getByRole('button', { name: 'Copy link to this chat' })).toBeVisible()
			await expect(page.getByRole('button', { name: 'Invite someone by email' })).toBeVisible()
			await expect(
				page.getByText('People see the whole thread. Agents you add start working from it.'),
			).toBeVisible()
			// The owner's sub-line names their relationship to the chat.
			await expect(page.getByText('You · owner of this chat')).toBeVisible()

			await page.getByPlaceholder('Search people and agents…').fill(agent.name)
			await page.getByRole('option', { name: new RegExp(agent.name) }).click()
			// The added agent moves up into the "In this chat" list.
			await expect(page.getByText(agent.name).first()).toBeVisible({ timeout: 10_000 })
		})
	}
})

test.describe('Chats v2 — new chat zero state', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`a suggestion prefills the composer without sending at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })
			await page.goto(`/${account.workspaceId}/chats/new`)

			await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible({
				timeout: 15_000,
			})
			await expectNoHorizontalOverflow(page)

			const composer = page.getByLabel('Message this conversation')
			await expect(composer).toHaveValue('')

			await page.getByRole('button', { name: 'Catch me up on billing' }).click()
			await expect(composer).toHaveValue('Catch me up on billing')
			// Prefill only — nothing was sent, so we're still on the draft route.
			await expect(page).toHaveURL(/\/chats\/new/)
		})
	}
})

test.describe('Chats v2 — light and dark', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the list, the unread dot and the own-message plate stay visible in ${scheme} mode`, async ({
			page,
			account,
		}) => {
			await page.emulateMedia({ colorScheme: scheme })
			const chats = await seedChats(account.api, account.workspaceId)
			const list = page.getByTestId('conversation-list')

			await page.goto(`/${account.workspaceId}/chats`)
			await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })

			await list.getByText(chats.plain).click()
			await expect(page.getByRole('heading', { name: chats.plain })).toBeVisible({
				timeout: 15_000,
			})

			const messageText = `Ink plate in ${scheme} ${Date.now()}`
			const composer = page.getByLabel('Message this conversation')
			await composer.fill(messageText)
			await composer.press('Enter')

			const bubble = page.getByTestId('thread-messages').getByText(messageText)
			await expect(bubble).toBeVisible({ timeout: 15_000 })
			// `bg-primary`/`text-primary-foreground` — the pair that inverts
			// correctly in both schemes, unlike `bg-accent` (known-pitfalls).
			const plate = await bubble.evaluate((el: HTMLElement) => {
				const parent = el.parentElement as HTMLElement
				const style = window.getComputedStyle(parent)
				return { background: style.backgroundColor, color: style.color }
			})
			expect(plate.background).not.toBe('rgba(0, 0, 0, 0)')
			expect(plate.background).not.toBe(plate.color)
		})
	}
})
