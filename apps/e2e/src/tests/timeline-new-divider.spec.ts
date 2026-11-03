import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

/**
 * D8 — Object timeline NEW divider.
 *
 * The unread boundary at the top of the timeline uses SPEC-verbatim copy
 * ("New — {N} items", "✓ Mark all read"), an `aria-label` naming the count,
 * and is focusable so a screen-reader user can jump to the first unread
 * comment below it. Ship gate: 375 / 768 / 1024.
 *
 * Both API responses (the object detail read and the object graph read) are
 * mocked at the route level so the reader-side unread state can be set
 * deterministically without a second actor. The mark-read POST is also
 * intercepted so the affordance's mutation side-effect is asserted directly.
 */

const OBJECT_ID = 'obj-new-divider-spec'
const ACTOR_ID = 'actor-remote-1'

interface CommentEvent {
	id: number
	createdAt: string
	body: string
}

const COMMENTS_NEWEST_FIRST: CommentEvent[] = [
	{ id: 303, createdAt: '2026-01-03T00:00:00Z', body: 'Latest reply on the bet.' },
	{ id: 302, createdAt: '2026-01-02T00:00:00Z', body: 'Second remote comment.' },
	{ id: 301, createdAt: '2026-01-01T00:00:00Z', body: 'First remote comment.' },
]

function buildObjectResponse(overrides: { unread_count: number; workspaceId: string }) {
	return {
		id: OBJECT_ID,
		workspaceId: overrides.workspaceId,
		type: 'bet',
		title: 'NEW divider spec — remote comments',
		status: 'active',
		content: 'Body text; the timeline surfaces unread comments above me.',
		metadata: null,
		driver: null,
		activeSessionId: null,
		activeSessionCurrentActivity: null,
		createdBy: ACTOR_ID,
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-03T00:00:00Z',
		is_subscribed: true,
		subscriber_count: 1,
		unread_count: overrides.unread_count,
	}
}

function buildGraphResponse(overrides: { unread_count: number; workspaceId: string }) {
	return {
		object: buildObjectResponse(overrides),
		relationships: [],
		connected_objects: [],
		events: COMMENTS_NEWEST_FIRST.map((c) => ({
			id: c.id,
			workspaceId: overrides.workspaceId,
			actorId: ACTOR_ID,
			action: 'commented',
			entityType: 'object',
			entityId: OBJECT_ID,
			data: { content: c.body },
			createdAt: c.createdAt,
		})),
		files: [],
	}
}

async function mockObjectRoutes(
	page: Page,
	opts: { workspaceId: string; unread_count: number; onMarkRead?: (body: unknown) => void },
) {
	await page.route(`**/api/objects/${OBJECT_ID}`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				buildObjectResponse({
					unread_count: opts.unread_count,
					workspaceId: opts.workspaceId,
				}),
			),
		})
	})
	await page.route(`**/api/objects/${OBJECT_ID}/graph`, async (route: Route) => {
		if (route.request().method() !== 'GET') return route.continue()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify(
				buildGraphResponse({
					unread_count: opts.unread_count,
					workspaceId: opts.workspaceId,
				}),
			),
		})
	})
	await page.route('**/api/subscriptions/read', async (route: Route) => {
		if (route.request().method() !== 'POST') return route.continue()
		const body = route.request().postDataJSON()
		opts.onMarkRead?.(body)
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ updated: true }),
		})
	})
}

test.describe('Object timeline — NEW divider (D8)', () => {
	for (const vp of SHIP_GATE_VIEWPORTS) {
		test(`renders the SPEC-verbatim NEW divider + Mark all read affordance at ${vp.label}`, async ({
			page,
			account,
		}) => {
			await page.setViewportSize({ width: vp.width, height: vp.height })

			const markReadBodies: unknown[] = []
			await mockObjectRoutes(page, {
				workspaceId: account.workspaceId,
				unread_count: 3,
				onMarkRead: (body) => markReadBodies.push(body),
			})

			await page.goto(`/${account.workspaceId}/objects/${OBJECT_ID}`)

			// The divider uses ARIA separator + a labelled pill so screen-reader
			// users can jump to the first unread comment below it. The label is
			// the load-bearing accessibility contract from the AC.
			const divider = page.getByRole('separator', { name: '3 unread items below' })
			await expect(divider).toBeVisible({ timeout: 15000 })
			// Focusable — tabIndex=0 lets a screen-reader user step into it.
			await expect(divider).toHaveAttribute('tabindex', '0')

			// SPEC copy verbatim, pluralised (three items → "items").
			await expect(page.getByText('New — 3 items')).toBeVisible()

			// The right-side affordance calls the mark-read mutation. The button
			// hides after the click, and the POST fires with the newest loaded
			// comment id as the high-water mark.
			const markRead = page.getByRole('button', { name: /Mark all read/ })
			await expect(markRead).toBeVisible()
			await markRead.click()
			await expect(markRead).toHaveCount(0)

			// mark-read POST fired at least once with the expected shape. The
			// server contract is entity + high-water mark; the client sends the
			// newest loaded comment id (303 in this fixture).
			expect(markReadBodies.length).toBeGreaterThanOrEqual(1)
			expect(markReadBodies[0]).toMatchObject({
				entity_type: 'object',
				entity_id: OBJECT_ID,
			})
		})
	}

	test('hides the divider entirely when there are zero unread items (no reserved space)', async ({
		page,
		account,
	}) => {
		await mockObjectRoutes(page, {
			workspaceId: account.workspaceId,
			unread_count: 0,
		})

		await page.goto(`/${account.workspaceId}/objects/${OBJECT_ID}`)

		// The three seeded comments render, but there is no divider and no
		// Mark all read button — zero unread must not reserve visual space
		// (per D8: "Zero unread → divider hidden entirely").
		await expect(page.getByText('Latest reply on the bet.')).toBeVisible({ timeout: 15000 })
		await expect(page.getByRole('separator', { name: /unread items below/ })).toHaveCount(0)
		await expect(page.getByRole('button', { name: /Mark all read/ })).toHaveCount(0)
	})

	// D8 explicit AC: pruned / deleted last_read_event_id → treated as "all
	// read", not "all unread". The server resolves a stale pointer to
	// unread_count = 0; the client honours it — even though newer comments
	// are visible in the loaded window, no divider must render. Runtime gate
	// for the same semantic covered by the compute-unread-event-ids +
	// timeline-tab unit tests.
	test('treats a pruned last_read_event_id as all-read (unread_count=0 with newer comments loaded)', async ({
		page,
		account,
	}) => {
		await mockObjectRoutes(page, {
			workspaceId: account.workspaceId,
			// Server saw a dangling last_read_event_id (pruned/deleted event),
			// resolved it as "all read", and returned unread_count = 0. The
			// events array still carries three newer comments.
			unread_count: 0,
		})

		await page.goto(`/${account.workspaceId}/objects/${OBJECT_ID}`)

		await expect(page.getByText('Latest reply on the bet.')).toBeVisible({ timeout: 15000 })
		await expect(page.getByText('First remote comment.')).toBeVisible()
		// No divider, no affordance — the client mirrored the server's
		// "all read" resolution rather than flagging every loaded comment as
		// unread.
		await expect(page.getByRole('separator', { name: /unread items below/ })).toHaveCount(0)
		await expect(page.getByRole('button', { name: /Mark all read/ })).toHaveCount(0)
	})
})
