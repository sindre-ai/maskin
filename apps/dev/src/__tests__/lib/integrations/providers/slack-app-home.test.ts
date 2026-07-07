import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getValidTokenMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'slack' } })),
}))

vi.mock('@maskin/db/schema', async (importOriginal) => {
	const actual = (await importOriginal()) as Record<string, unknown>
	return {
		...actual,
		notifications: { __isTaggedNotifications: true },
		actors: { __isTaggedActors: true },
		slackUserLinks: { __isTaggedSlackUserLinks: true },
		integrations: { __isTaggedIntegrations: true },
		workspaces: { __isTaggedWorkspaces: true },
	}
})

interface LinkRow {
	actorId: string
	defaultWorkspaceId: string
}

interface InboxRow {
	id: string
	title: string
	content: string | null
	objectId: string | null
	sourceActorName: string | null
	updatedAt: string | null
	createdAt: string | null
}

interface IntegrationRow {
	id: string
}

interface WorkspaceRow {
	name: string
}

function tableName(table: unknown): string {
	if (table && typeof table === 'object') {
		if ('__isTaggedSlackUserLinks' in table) return 'slack_user_links'
		if ('__isTaggedNotifications' in table) return 'notifications'
		if ('__isTaggedIntegrations' in table) return 'integrations'
		if ('__isTaggedWorkspaces' in table) return 'workspaces'
	}
	return 'unknown'
}

function makeFakeDb(opts: {
	link?: LinkRow | null
	inbox?: InboxRow[]
	integration?: IntegrationRow | null
	workspace?: WorkspaceRow | null
}) {
	const link = opts.link ?? null
	const inbox = opts.inbox ?? []
	const integration = opts.integration ?? { id: 'int-1' }
	const workspace = opts.workspace === undefined ? { name: 'Acme' } : opts.workspace

	return {
		select: (_cols?: unknown) => ({
			from: (table: unknown) => {
				const name = tableName(table)
				if (name === 'notifications') {
					return {
						leftJoin: () => ({
							where: () => ({
								orderBy: () => ({
									limit: () => Promise.resolve(inbox),
								}),
							}),
						}),
					}
				}
				if (name === 'slack_user_links') {
					return {
						where: () => ({
							limit: () => Promise.resolve(link ? [link] : []),
						}),
					}
				}
				if (name === 'integrations') {
					return {
						where: () => ({
							limit: () => Promise.resolve(integration ? [integration] : []),
						}),
					}
				}
				if (name === 'workspaces') {
					return {
						where: () => ({
							limit: () => Promise.resolve(workspace ? [workspace] : []),
						}),
					}
				}
				return {
					where: () => ({ limit: () => Promise.resolve([]) }),
				}
			},
		}),
	}
}

describe('publishAppHomeView', () => {
	const fetchMock = vi.fn()

	beforeEach(async () => {
		getValidTokenMock.mockReset().mockResolvedValue('xoxb-test')
		fetchMock.mockReset().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		})
		vi.stubGlobal('fetch', fetchMock)
		const mod = await import('../../../../lib/integrations/providers/slack/webhooks')
		mod._resetAppHomeDebounce()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it('renders the unlinked-state view when no slack_user_links row exists', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const db = makeFakeDb({ link: null })

		const published = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
		})
		expect(published).toBe(true)

		const call = fetchMock.mock.calls[0]
		expect(call?.[0]).toContain('views.publish')
		const body = JSON.parse((call?.[1] as { body: string }).body) as {
			user_id: string
			view: { type: string; blocks: Array<Record<string, unknown>> }
		}
		expect(body.user_id).toBe('U1')
		expect(body.view.type).toBe('home')
		// Header + the connect section.
		const sections = body.view.blocks.filter((b) => b.type === 'section')
		expect(sections).toHaveLength(1)
		const accessory = sections[0]?.accessory as { text: { text: string } } | undefined
		expect(accessory?.text.text).toBe('Connect Maskin')
	})

	it('renders the linked-state view with a Falu-red agent + workspace subscript per row', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const inbox: InboxRow[] = [
			{
				id: 'n1',
				title: 'Brief incomplete — missing References',
				content: null,
				objectId: 'obj-1',
				sourceActorName: 'Workspace Coach',
				createdAt: '2026-06-22T20:00:00Z',
				updatedAt: '2026-06-22T20:00:00Z',
			},
			{
				id: 'n2',
				title: 'Architecture proposal ready for review',
				content: null,
				objectId: 'obj-2',
				sourceActorName: 'Architect',
				createdAt: '2026-06-22T19:00:00Z',
				updatedAt: '2026-06-22T19:00:00Z',
			},
		]
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox,
			workspace: { name: 'Acme' },
		})

		await publishAppHomeView({ db: db as never, teamId: 'T1', slackUserId: 'U1' })

		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
			view: { blocks: Array<Record<string, unknown>> }
		}
		const headerText = (body.view.blocks[0] as { text: { text: string } }).text.text
		expect(headerText).toBe('For You — 2 unread')

		const ctaButton = (
			body.view.blocks[1] as { elements: Array<{ text: { text: string }; url: string }> }
		).elements[0]
		expect(ctaButton?.text.text).toBe('Open For You in Maskin ↗')
		expect(ctaButton?.url).toContain('/ws-1/inbox')

		// Each row is followed by a Falu-red context block carrying both the
		// agent display name and the linked Maskin workspace name.
		const contextBlocks = body.view.blocks.filter((b) => b.type === 'context') as Array<{
			elements: Array<{ text: string }>
		}>
		expect(contextBlocks).toHaveLength(2)
		const subscripts = contextBlocks.map((c) => c.elements[0]?.text)
		expect(subscripts[0]).toBe('<#7C1F1A|↳ Workspace Coach (Acme)>')
		expect(subscripts[1]).toBe('<#7C1F1A|↳ Architect (Acme)>')
	})

	it('renders the agent-only subscript when the workspace row is missing', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const inbox: InboxRow[] = [
			{
				id: 'n1',
				title: 'Brief incomplete',
				content: null,
				objectId: 'obj-1',
				sourceActorName: 'Workspace Coach',
				createdAt: '2026-06-22T20:00:00Z',
				updatedAt: '2026-06-22T20:00:00Z',
			},
		]
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox,
			workspace: null,
		})

		await publishAppHomeView({ db: db as never, teamId: 'T1', slackUserId: 'U1' })

		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
			view: { blocks: Array<Record<string, unknown>> }
		}
		const contextBlock = body.view.blocks.find((b) => b.type === 'context') as
			| { elements: Array<{ text: string }> }
			| undefined
		expect(contextBlock?.elements[0]?.text).toBe('<#7C1F1A|↳ Workspace Coach>')
	})

	it('renders an empty-state body when the inbox is empty', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox: [],
		})

		await publishAppHomeView({ db: db as never, teamId: 'T1', slackUserId: 'U1' })

		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
			view: { blocks: Array<Record<string, unknown>> }
		}
		const headerText = (body.view.blocks[0] as { text: { text: string } }).text.text
		expect(headerText).toBe('For You — 0 unread')
		const lastSection = body.view.blocks.find((b) => b.type === 'section') as
			| { text: { text: string } }
			| undefined
		expect(lastSection?.text.text).toBe('_Nothing needs you right now._')
	})

	it('debounces a second publish for the same (team,user) within 1s', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox: [],
		})

		const t0 = 1_000_000
		const first = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
			now: t0,
		})
		const second = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
			now: t0 + 500,
		})
		const third = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
			now: t0 + 1_500,
		})

		expect(first).toBe(true)
		expect(second).toBe(false)
		expect(third).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('debounce keys by user — a different user is not throttled', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox: [],
		})

		const t0 = 1_000_000
		const u1 = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
			now: t0,
		})
		const u2 = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U2',
			now: t0 + 100,
		})

		expect(u1).toBe(true)
		expect(u2).toBe(true)
	})

	it('bypassDebounce overrides the throttle (onboarding hand-off)', async () => {
		const { publishAppHomeView } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const db = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			inbox: [],
		})

		const t0 = 1_000_000
		await publishAppHomeView({ db: db as never, teamId: 'T1', slackUserId: 'U1', now: t0 })
		const bypass = await publishAppHomeView({
			db: db as never,
			teamId: 'T1',
			slackUserId: 'U1',
			now: t0 + 10,
			bypassDebounce: true,
		})

		expect(bypass).toBe(true)
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})

	it('renders the actor display name verbatim — no fixed allow-list', async () => {
		const { _internal } = await import('../../../../lib/integrations/providers/slack/webhooks')
		expect(_internal.formatAgentSubscript('Workspace Coach', 'Acme')).toBe(
			'↳ Workspace Coach (Acme)',
		)
		expect(_internal.formatAgentSubscript('Strategist', 'Acme')).toBe('↳ Strategist (Acme)')
		expect(_internal.formatAgentSubscript('Custom Bot', 'Acme')).toBe('↳ Custom Bot (Acme)')
		expect(_internal.formatAgentSubscript(null, 'Acme')).toBe('')
		expect(_internal.formatAgentSubscript('Workspace Coach', null)).toBe('↳ Workspace Coach')
		expect(_internal.formatAgentSubscript('Workspace Coach', undefined)).toBe('↳ Workspace Coach')
	})

	it('escapes mrkdwn metacharacters in the actor + workspace names', async () => {
		const { _internal } = await import('../../../../lib/integrations/providers/slack/webhooks')
		// `|` would close the `<#HEX|text>` link early; `<` / `>` could open a
		// sibling tag. All three must be escaped before they reach the wrapper.
		expect(_internal.formatAgentSubscript('Pipe|Bot', 'Sharp<Acme>')).toBe(
			'↳ Pipe&#124;Bot (Sharp&lt;Acme&gt;)',
		)
	})

	it('app_home_opened normalizer round-trip emits slack.app_home_opened', async () => {
		const { slackEventNormalizer } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const result = slackEventNormalizer(
			{
				type: 'event_callback',
				team_id: 'T1',
				event: { type: 'app_home_opened', user: 'U1', tab: 'home' },
			},
			{},
		)
		expect(result?.entityType).toBe('slack.app_home_opened')
		expect(result?.action).toBe('opened')
		expect(result?.installationId).toBe('T1')
	})
})
