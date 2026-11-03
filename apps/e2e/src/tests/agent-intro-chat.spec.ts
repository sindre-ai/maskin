import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { VIEWPORTS } from '../helpers/viewports'

/**
 * A new agent introduces itself in the direct message with the person who
 * created it, titled with the agent's name (bet/e9ce-agent-intro-chat-routing, slice 2).
 *
 * Not covered here: an agent reply to a message in the intro chat, and asking
 * Chief of Staff in the UI to create an agent. Both need a workspace with real
 * LLM credentials, which the e2e stack does not have.
 */

test.describe('Agent intro chat', () => {
	test('creating an agent in the UI puts an unread direct message with its intro in the list', async ({
		page,
		account,
	}) => {
		await page.goto(`/${account.workspaceId}/chats`)

		const name = `Intro Agent ${Date.now()}`
		await page.locator('header').getByRole('button', { name: 'More ways to start' }).click()
		await page.getByRole('menuitem', { name: /new agent/i }).click()
		await page.getByRole('dialog').getByLabel('Title', { exact: true }).fill(name)
		await page.getByRole('dialog').getByLabel('Title', { exact: true }).press('Enter')
		await expect(page).toHaveURL(new RegExp(`/${account.workspaceId}/agents/`))

		// The intro lands within seconds of creation; the chat list refreshes on its own.
		await page.goto(`/${account.workspaceId}/chats`)
		const row = page.getByRole('link', { name: new RegExp(name) })
		await expect(row).toBeVisible({ timeout: 15_000 })
		await expect(row.getByLabel('1 unread')).toBeVisible()

		await row.click()
		await expect(page.getByRole('heading', { name })).toBeVisible()
		// The tag input draws its placeholder as text behind the box, not as an attribute.
		await expect(page.getByText(`Reply to ${name}…`)).toBeVisible()
		// The chat list's snippet repeats the same text beside the thread, so take the first match.
		await expect(page.getByText(`I'm ${name}.`).first()).toBeVisible()
		// The e2e workspace has no LLM credentials, so the intro says it cannot run yet instead of
		// offering first steps.
		await expect(page.getByText("I can't run yet.").first()).toBeVisible()
	})
})

/**
 * The intro's step buttons and needed-tool rows (slice 5a). The intro message is
 * injected at the transport, like the Connect card spec: its steps, tools and
 * plain_tail keys are backend-owned and stripped from anything a client posts, so
 * a seeded message could not carry them. The real write path is covered against
 * Postgres in apps/dev/src/__tests__/integration/agent-intro.test.ts. The flag is
 * turned on with the client-side test override, so this runs in a stack that
 * does not list the actor as a tester.
 */
const INTRO_AGENT = { id: '55555555-5555-4555-8555-555555555555', name: 'Scout' }

const INTRO_BODY = [
	"Hey Sam, I'm Scout.",
	'Start with one of these, or tell me what you need.',
	'1. Summarise open bugs\n2. Draft a reply\n3. What can you help me with?',
	"For this job I use Linear. Add any that aren't connected yet under Settings, Integrations.",
].join('\n\n')

const INTRO_STEPS = [
	{ label: 'Summarise open bugs', prompt: 'Summarise open bugs', action: 'send' },
	{ label: 'Draft a reply', prompt: 'Draft a reply to: ', action: 'fill' },
	{ label: 'What can you help me with?', prompt: 'What can you help me with?', action: 'send' },
]

async function stubIntroThread(page: Page, conversationId: string) {
	const intro = {
		id: 9201,
		conversationId,
		actorId: INTRO_AGENT.id,
		actorName: INTRO_AGENT.name,
		actorType: 'agent' as const,
		kind: 'message' as const,
		content: INTRO_BODY,
		metadata: {
			delivery: { kind: 'agent_intro', version: 1 },
			suggested_steps: INTRO_STEPS,
			needed_tools: [{ provider: 'linear' }],
			plain_tail: 2,
		},
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
	}
	const posted: Array<Record<string, unknown>> = []
	// What the server would return: oldest first here, newest first on the wire. A sent
	// message joins the thread, or the refetch after the send would drop it again.
	const thread: Array<Record<string, unknown>> = [intro]
	await page.route('**/api/conversations/*/messages*', async (route) => {
		const method = route.request().method()
		if (method === 'POST') {
			const body = route.request().postDataJSON() as Record<string, unknown>
			posted.push(body)
			const sent = {
				id: 9202,
				conversationId,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				kind: 'message',
				content: body.content,
				metadata: body.metadata ?? null,
				sessionId: null,
				createdAt: new Date().toISOString(),
				editedAt: null,
			}
			thread.push(sent)
			return route.fulfill({
				status: 201,
				contentType: 'application/json',
				body: JSON.stringify(sent),
			})
		}
		if (method !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ messages: [...thread].reverse(), has_more: false }),
		})
	})
	// The step row is disabled when the agent is missing from the actor list, so list it.
	await page.route(/\/api\/actors(\?.*)?$/, async (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		const response = await route.fetch()
		const actors = (await response.json()) as unknown[]
		await route.fulfill({
			response,
			json: [
				...actors,
				{ id: INTRO_AGENT.id, name: INTRO_AGENT.name, type: 'agent', role: 'member' },
			],
		})
	})
	await page.route('**/api/integrations/providers', (route) =>
		route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify([
				{ name: 'linear', displayName: 'Linear', authType: 'oauth2', events: [] },
			]),
		}),
	)
	await page.route(/\/api\/integrations(\?.*)?$/, (route) => {
		if (route.request().method() !== 'GET') return route.continue()
		return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
	})
	return posted
}

test.describe('Agent intro steps and tools', () => {
	for (const viewport of [VIEWPORTS.mobile, VIEWPORTS.desktop]) {
		test(`draws stacked step buttons and a tool row, with no plain list, at ${viewport.label}`, async ({
			page,
			account,
		}) => {
			const conversation = await account.api.createConversation(account.workspaceId, {
				title: `Meet Scout ${Date.now()}`,
				participant_actor_ids: [],
				initial_message: 'hello',
			})
			await stubIntroThread(page, conversation.id)
			await page.setViewportSize({ width: viewport.width, height: viewport.height })
			await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

			const steps = page.getByRole('group', { name: 'Suggested first steps' }).getByRole('button')
			await expect(steps).toHaveCount(3)
			// Stacked: one per line, same left edge, each at least 44px tall.
			const boxes = await steps.evaluateAll((els) =>
				els.map((el) => {
					const r = el.getBoundingClientRect()
					return { x: r.x, y: r.y, height: r.height }
				}),
			)
			for (const [i, box] of boxes.entries()) {
				expect(box.height).toBeGreaterThanOrEqual(44)
				if (i > 0) {
					expect(box.x).toBe(boxes[0]?.x)
					expect(box.y).toBeGreaterThan(boxes[i - 1]?.y ?? 0)
				}
			}
			await expect(page.getByRole('heading', { name: 'Tools for this job' })).toBeVisible()
			await expect(page.getByText('Not connected yet')).toBeVisible()
			// The plain list and tools sentence are what the buttons and row replace.
			await expect(page.getByText('1. Summarise open bugs')).toHaveCount(0)
			await expect(page.getByText(/For this job I use Linear/)).toHaveCount(0)
		})
	}

	test('a send step posts its label once with the step marker, and a fill step fills the box', async ({
		page,
		account,
	}) => {
		const conversation = await account.api.createConversation(account.workspaceId, {
			title: `Meet Scout tap ${Date.now()}`,
			participant_actor_ids: [],
			initial_message: 'hello',
		})
		const posted = await stubIntroThread(page, conversation.id)
		await page.goto(`/${account.workspaceId}/chats/${conversation.id}`)

		// Fill: the box takes the prompt, keeps focus, and nothing is sent.
		await page.getByRole('button', { name: /Draft a reply/ }).click()
		const box = page.getByLabel('Message this conversation')
		await expect(box).toHaveText('Draft a reply to:')
		await expect(box).toBeFocused()
		expect(
			await page.evaluate((id) => sessionStorage.getItem(`composer-draft:${id}`), conversation.id),
		).toBe('Draft a reply to: ')
		expect(posted).toHaveLength(0)

		// Send: two clicks in one tick make one POST, carrying the marker; the draft stays.
		const send = page.getByRole('button', { name: /Summarise open bugs/ })
		await send.evaluate((el) => {
			;(el as HTMLButtonElement).click()
			;(el as HTMLButtonElement).click()
		})
		await expect.poll(() => posted.length).toBe(1)
		expect(posted[0]).toMatchObject({
			content: 'Summarise open bugs',
			metadata: { from_suggested_step: { intro_message_id: 9201, index: 0 } },
		})
		await expect(box).toHaveText('Draft a reply to:')
		// The tapped button is gone, so focus goes to the box for a follow-up.
		await expect(box).toBeFocused()
		// The steps leave once the person has written; the tool row stays.
		await expect(page.getByRole('group', { name: 'Suggested first steps' })).toHaveCount(0)
		await expect(page.getByRole('heading', { name: 'Tools for this job' })).toBeVisible()
	})
})
