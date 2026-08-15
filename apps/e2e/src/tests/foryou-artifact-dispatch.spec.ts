import type { Page, Route } from '@playwright/test'
import { expect, test } from '../fixtures/auth.fixture'
import { SHIP_GATE_VIEWPORTS } from '../helpers/viewports'

// DoD 1–3 of `Wire artifact renderers — dispatch by option.kind in
// foryou-card-queue`: single-item decision notifications carrying
// `metadata.artifacts[0].kind` route to the matching dedicated renderer
// (Mail / Post / Visual / Metric / Diff). Multi-item groups keep the
// generic bulk-approve card.

interface NotificationFixture {
	id: string
	workspaceId: string
	type: 'needs_input' | 'recommendation' | 'good_news' | 'alert'
	title: string
	content: string | null
	metadata: Record<string, unknown> | null
	sourceActorId: string
	targetActorId: string | null
	objectId: string | null
	sessionId: string | null
	status: 'pending' | 'seen' | 'resolved' | 'dismissed' | 'expired'
	resolvedAt: string | null
	expiresAt: string | null
	defaultAction: string | null
	dispatchAt: string | null
	wakeDispatched: boolean
	createdAt: string
	updatedAt: string
}

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const FILE_ID = '11111111-1111-4111-8111-111111111112'

const OBJ_MAIL = '22222222-2222-4222-8222-222222222201'
const OBJ_POST = '22222222-2222-4222-8222-222222222202'
const OBJ_VISUAL = '22222222-2222-4222-8222-222222222203'
const OBJ_METRIC = '22222222-2222-4222-8222-222222222204'
const OBJ_DIFF = '22222222-2222-4222-8222-222222222205'

const ID_MAIL = '66666666-6666-4666-8666-666666660001'
const ID_POST = '66666666-6666-4666-8666-666666660002'
const ID_VISUAL = '66666666-6666-4666-8666-666666660003'
const ID_METRIC = '66666666-6666-4666-8666-666666660004'
const ID_DIFF = '66666666-6666-4666-8666-666666660005'

function buildNotification(
	workspaceId: string,
	overrides: Partial<NotificationFixture> & Pick<NotificationFixture, 'id' | 'title'>,
): NotificationFixture {
	const now = new Date().toISOString()
	return {
		workspaceId,
		type: 'needs_input',
		content: null,
		metadata: null,
		sourceActorId: AGENT_ID,
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		expiresAt: null,
		defaultAction: null,
		dispatchAt: null,
		wakeDispatched: false,
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

function decisionMetadata(kind: 'mail' | 'post' | 'visual' | 'metric' | 'diff') {
	return {
		attention_needed: true,
		artifacts: [{ kind, fileId: FILE_ID, title: `${kind} artifact` }],
		options: [
			{ label: 'Approve', value: 'approve', default: true },
			{ label: 'Reject', value: 'reject' },
		],
		asked: `Approve this ${kind}?`,
		found: `Agent surfaced a ${kind} decision.`,
		recommendation: 'approve',
	}
}

async function mockNotifications(page: Page, workspaceId: string) {
	const respondCalls: Array<{ id: string; response: unknown }> = []
	const notifications: NotificationFixture[] = [
		buildNotification(workspaceId, {
			id: ID_MAIL,
			title: 'Approve outbound reply',
			objectId: OBJ_MAIL,
			metadata: decisionMetadata('mail'),
		}),
		buildNotification(workspaceId, {
			id: ID_POST,
			title: 'Approve marketing post',
			objectId: OBJ_POST,
			metadata: decisionMetadata('post'),
		}),
		buildNotification(workspaceId, {
			id: ID_VISUAL,
			title: 'Approve hero image',
			objectId: OBJ_VISUAL,
			metadata: decisionMetadata('visual'),
		}),
		buildNotification(workspaceId, {
			id: ID_METRIC,
			title: 'Approve KPI push',
			objectId: OBJ_METRIC,
			metadata: decisionMetadata('metric'),
		}),
		buildNotification(workspaceId, {
			id: ID_DIFF,
			title: 'Approve pending diff',
			objectId: OBJ_DIFF,
			metadata: decisionMetadata('diff'),
		}),
	]

	await page.route('**/api/notifications**', async (route: Route) => {
		const req = route.request()
		const url = new URL(req.url())

		if (req.method() === 'GET' && url.pathname.endsWith('/api/notifications')) {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify(notifications),
			})
			return
		}

		const respondMatch = url.pathname.match(/\/api\/notifications\/([^/]+)\/respond$/)
		if (req.method() === 'POST' && respondMatch) {
			const id = respondMatch[1]
			const body = req.postDataJSON() as { response: unknown }
			respondCalls.push({ id, response: body.response })
			const target = notifications.find((n) => n.id === id)
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					...target,
					status: 'resolved',
					resolvedAt: new Date().toISOString(),
				}),
			})
			return
		}

		await route.fallback()
	})

	await page.route('**/api/subscriptions/unread*', async (route: Route) => {
		if (route.request().method() !== 'GET') return route.fallback()
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ items: [] }),
		})
	})

	return { respondCalls }
}

for (const viewport of SHIP_GATE_VIEWPORTS) {
	test.describe(`For You artifact dispatch @ ${viewport.label}`, () => {
		test.use({ viewport: { width: viewport.width, height: viewport.height } })

		test('routes each artifact kind to its dedicated renderer', async ({ page, account }) => {
			await mockNotifications(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			await expect(page.getByTestId('foryou-card-queue')).toBeVisible()
			await expect(page.getByTestId('foryou-mail-renderer')).toBeVisible()
			await expect(page.getByTestId('foryou-post-renderer')).toBeVisible()
			await expect(page.getByTestId('foryou-visual-renderer')).toBeVisible()
			await expect(page.getByTestId('foryou-metric-renderer')).toBeVisible()
			await expect(page.getByTestId('foryou-diff-renderer')).toBeVisible()
		})

		test('mail card shows the decision block, sender strip, and a working reverse window', async ({
			page,
			account,
		}) => {
			const { respondCalls } = await mockNotifications(page, account.workspaceId)
			await page.goto(`/${account.workspaceId}`)

			const mailCard = page.getByTestId('foryou-mail-renderer')
			await expect(mailCard).toBeVisible()
			await expect(mailCard.getByTestId('decision-block')).toBeVisible()
			await expect(mailCard.getByTestId('waiting-on-you-indicator')).toHaveText('Waiting on you')

			await mailCard.getByRole('button', { name: /approve/i }).click()

			// Receipt block shows with a Reverse control and no POST fires yet
			// (server-side commit only happens after the 6s window elapses).
			await expect(mailCard.getByTestId('decision-receipt')).toBeVisible()
			await expect(mailCard.getByRole('button', { name: /reverse/i })).toBeVisible()
			expect(respondCalls.length).toBe(0)

			await mailCard.getByRole('button', { name: /reverse/i }).click()
			await expect(mailCard.getByTestId('decision-receipt')).toHaveCount(0)
			await expect(mailCard.getByTestId('decision-block')).toBeVisible()
			expect(respondCalls.length).toBe(0)
		})
	})
}
