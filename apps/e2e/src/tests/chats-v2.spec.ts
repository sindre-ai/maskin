import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { TestAPI } from '../helpers/api.helper'
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
	test('labels the group a fresh conversation lands in', async ({ page, account }) => {
		const chats = await seedChats(account.api, account.workspaceId)
		const list = page.getByTestId('conversation-list')

		await page.goto(`/${account.workspaceId}/chats`)
		await expect(list.getByText(chats.plain)).toBeVisible({ timeout: 15_000 })
		// Pinned sorts above the dated groups.
		await expect(list.getByText('Pinned', { exact: true })).toBeVisible()
		await expect(list.getByText('Today', { exact: true })).toBeVisible()
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

	test('the shared nav row stays on one line at 375px', async ({ page, account }) => {
		await page.setViewportSize(VIEWPORTS.mobile)
		await seedChats(account.api, account.workspaceId)

		await page.goto(`/${account.workspaceId}/chats`)
		await expect(page.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 })

		// The title and the New button share a row: wrapping drops New to a
		// second line, which is what this asserts against.
		const heading = await page.getByRole('heading', { name: 'Chats' }).boundingBox()
		const newButton = await page.getByRole('button', { name: 'New chat' }).first().boundingBox()
		expect(heading).not.toBeNull()
		expect(newButton).not.toBeNull()
		expect(Math.abs((newButton?.y ?? 0) - (heading?.y ?? 0))).toBeLessThan(16)

		// Icon-only at this width, but still named for assistive tech.
		const filter = page.getByRole('button', { name: /^Filter conversations/ })
		await expect(filter).toBeVisible()
		expect((await filter.boundingBox())?.width ?? 999).toBeLessThan(56)
	})

	test('the nav controls are all the same height', async ({ page, account }) => {
		await seedChats(account.api, account.workspaceId)
		await page.goto(`/${account.workspaceId}/chats`)
		await expect(page.getByTestId('conversation-list')).toBeVisible({ timeout: 15_000 })

		const heights = await Promise.all(
			[
				page.getByRole('button', { name: 'Search the workspace' }),
				page.getByRole('button', { name: /^Filter conversations/ }),
				page.getByRole('button', { name: 'New chat' }).first(),
			].map(async (l) => (await l.boundingBox())?.height ?? 0),
		)
		expect(heights.every((h) => h > 0)).toBe(true)
		expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
	})

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
			// Deliberately absent — see participants-popover.tsx: a mailto link
			// promises access to someone who is not in the workspace.
			await expect(page.getByRole('button', { name: /Invite/ })).toHaveCount(0)
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

test.describe('Chats v2 — citation pill', () => {
	for (const scheme of ['light', 'dark'] as const) {
		test(`the citation pill's type dot, title and status word stay legible in ${scheme} mode`, async ({
			page,
			account,
		}) => {
			// The pill draws status as a bare coloured word on `bg-card`, with no
			// pill of its own to sit against. A status the workspace configured
			// itself falls back to the default colour, and that fallback used to be
			// light text sized for a dark pill — invisible on white. This is the
			// known-pitfalls "token used without its foreground pair" shape, and it
			// only ever shows up in one scheme, so both are asserted.
			await page.emulateMedia({ colorScheme: scheme })
			const stamp = Date.now()

			// A status outside the workspace's configured list is a 400 at
			// `POST /objects`, so the uncoloured status has to be configured
			// before it can be cited — that is what a workspace that renamed
			// its own statuses looks like.
			await account.api.updateWorkspace(account.workspaceId, {
				settings: {
					statuses: { bet: ['active'], task: ['awaiting_legal'] },
				},
			})

			const known = await account.api.createObject(account.workspaceId, {
				type: 'bet',
				title: `Retry window ${stamp}`,
				status: 'active',
			})
			const custom = await account.api.createObject(account.workspaceId, {
				type: 'task',
				title: `Legal review ${stamp}`,
				// Deliberately outside `statusColors` — statuses are workspace-
				// configurable, so the fallback is a real user-facing path.
				status: 'awaiting_legal',
			})

			// The citation pill is an *incoming* message affordance: the viewer's
			// own messages lift their context out as `You attached` chips instead,
			// so the cited message has to come from another actor.
			const agent = await account.api.createAgentActor(`Citing Agent ${stamp}`)
			await account.api.addWorkspaceMember(account.workspaceId, agent.id)
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `V2 Citations ${stamp}`,
				participant_actor_ids: [agent.id],
				initial_message: 'Opening the thread',
			})
			const agentApi = new TestAPI(agent.api_key)
			await agentApi.postConversationMessage(conversation.id, account.workspaceId, {
				content: 'Both of these are blocked on the same thing.',
				metadata: {
					context_objects: [
						{ id: known.id, title: known.title, type: known.type },
						{ id: custom.id, title: custom.title, type: custom.type },
					],
				},
			})

			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)
			const transcript = page.getByTestId('thread-messages')
			await expect(transcript.getByText('Referenced')).toBeVisible({ timeout: 15_000 })

			for (const object of [known, custom]) {
				const pill = transcript.getByRole('link', { name: new RegExp(object.title) })
				await expect(pill).toBeVisible()

				// Every painted part of the pill must clear 3:1 against the pill's own
				// background — the status word included, which is the part that has no
				// background of its own to guarantee it.
				const contrast = await pill.evaluate((el: HTMLElement) => {
					const luminance = (colour: string) => {
						const [r, g, b] = (colour.match(/[\d.]+/g) ?? ['0', '0', '0']).map(Number)
						const channel = (v: number) => {
							const s = v / 255
							return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
						}
						return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
					}
					const ratio = (a: string, b: string) => {
						const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
						return (x + 0.05) / (y + 0.05)
					}
					const background = window.getComputedStyle(el).backgroundColor
					// The status word is the last element child; the title is the span
					// carrying the object's name.
					const parts = Array.from(el.children) as HTMLElement[]
					return parts.map((part) => ({
						// The type dot carries no text — `bg-current` paints it from
						// `color`, so the same read covers it.
						text: part.textContent?.trim() || 'the type dot',
						ratio: ratio(window.getComputedStyle(part).color, background),
					}))
				})

				expect(contrast.length).toBeGreaterThan(0)
				for (const part of contrast) {
					expect(
						part.ratio,
						`"${part.text}" in ${scheme} mode against the pill background`,
					).toBeGreaterThan(3)
				}
			}

			await expectNoHorizontalOverflow(page)
		})
	}
})
