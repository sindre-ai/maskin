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
		slackUserLinks: { __tag: 'slack_user_links' },
		integrations: { __tag: 'integrations' },
		workspaces: { __tag: 'workspaces' },
		workspaceMembers: { __tag: 'workspace_members' },
		objects: { __tag: 'objects' },
		actors: { __tag: 'actors' },
	}
})

// Baseline env for parseMaskinObjectUrl + frontendBaseUrl.
const BASE_URL = 'https://maskin.io'

interface ObjectRow {
	id: string
	workspaceId: string
	type: string
	title: string | null
	status: string
	driver: string | null
}

interface LinkRow {
	actorId: string
}

interface MemberRow {
	actorId?: string
	workspaceId?: string
	name?: string
}

interface WorkspaceRow {
	settings: { statuses?: Record<string, string[]> } | null
}

function tableName(table: unknown): string {
	if (table && typeof table === 'object' && '__tag' in table) {
		return String((table as { __tag: string }).__tag)
	}
	return 'unknown'
}

interface FakeDbOpts {
	link?: LinkRow | null
	integration?: { id: string; config: unknown } | null
	memberOfWorkspaces?: string[]
	objects?: ObjectRow[]
	workspaceSettings?: WorkspaceRow['settings']
	workspaceMembers?: MemberRow[]
	drivers?: Array<{ id: string; name: string }>
}

// Minimal chainable fake — every table returns a bespoke chain that resolves
// with the seeded rows for that table. Enough surface for the module under
// test; not a general-purpose Drizzle mock.
function makeFakeDb(opts: FakeDbOpts) {
	return {
		select: (_cols?: unknown) => ({
			from: (table: unknown) => {
				const name = tableName(table)
				if (name === 'slack_user_links') {
					return {
						where: () => ({
							limit: () => Promise.resolve(opts.link ? [opts.link] : []),
						}),
					}
				}
				if (name === 'integrations') {
					return {
						where: () => ({
							limit: () => Promise.resolve(opts.integration ? [opts.integration] : []),
						}),
					}
				}
				if (name === 'workspaces') {
					return {
						where: () => ({
							limit: () =>
								Promise.resolve(
									opts.workspaceSettings === undefined
										? []
										: [{ settings: opts.workspaceSettings }],
								),
						}),
					}
				}
				if (name === 'workspace_members') {
					// fetchWorkspaceLookup: .innerJoin(actors).where().limit()
					// member-of check: .where() awaited directly (no .limit())
					const memberOfRows = (opts.memberOfWorkspaces ?? []).map((workspaceId) => ({
						workspaceId,
					}))
					return {
						innerJoin: () => ({
							where: () => ({
								limit: () => Promise.resolve(opts.workspaceMembers ?? []),
							}),
						}),
						where: () => Promise.resolve(memberOfRows),
					}
				}
				if (name === 'objects') {
					return {
						where: () => Promise.resolve(opts.objects ?? []),
					}
				}
				if (name === 'actors') {
					return {
						where: () => Promise.resolve(opts.drivers ?? []),
					}
				}
				return {
					where: () => ({ limit: () => Promise.resolve([]) }),
				}
			},
		}),
		update: () => ({
			set: () => ({ where: () => Promise.resolve() }),
		}),
	}
}

const WS_A = '11111111-1111-1111-1111-111111111111'
const OBJ_A = '22222222-2222-2222-2222-222222222222'
const OBJ_B = '33333333-3333-3333-3333-333333333333'
const ACTOR_A = '44444444-4444-4444-4444-444444444444'
const DRIVER_ACTOR = '55555555-5555-5555-5555-555555555555'
const OTHER_ACTOR = '66666666-6666-6666-6666-666666666666'

describe('parseMaskinObjectUrl', () => {
	it('parses a valid maskin object URL', async () => {
		const { parseMaskinObjectUrl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		expect(parseMaskinObjectUrl(`${BASE_URL}/${WS_A}/objects/${OBJ_A}`, BASE_URL)).toEqual({
			workspaceId: WS_A,
			objectId: OBJ_A,
		})
	})

	it('rejects a URL whose host does not match the base URL', async () => {
		const { parseMaskinObjectUrl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		// Phishing shape: `maskin.io.evil.com/{ws}/objects/{obj}` — hostname
		// mismatch must drop through without a fetch.
		expect(
			parseMaskinObjectUrl(`https://maskin.io.evil.com/${WS_A}/objects/${OBJ_A}`, BASE_URL),
		).toBeNull()
	})

	it('rejects a non-object route on the same host', async () => {
		const { parseMaskinObjectUrl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		expect(parseMaskinObjectUrl(`${BASE_URL}/${WS_A}/inbox`, BASE_URL)).toBeNull()
		expect(parseMaskinObjectUrl(`${BASE_URL}/${WS_A}/sessions/${OBJ_A}`, BASE_URL)).toBeNull()
	})

	it('rejects URLs with non-UUID segments', async () => {
		const { parseMaskinObjectUrl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		expect(parseMaskinObjectUrl(`${BASE_URL}/not-a-uuid/objects/${OBJ_A}`, BASE_URL)).toBeNull()
		expect(parseMaskinObjectUrl(`${BASE_URL}/${WS_A}/objects/not-a-uuid`, BASE_URL)).toBeNull()
	})

	it('returns null on unparseable URLs', async () => {
		const { parseMaskinObjectUrl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		expect(parseMaskinObjectUrl('not a url', BASE_URL)).toBeNull()
	})
})

describe('buildCompactUnfurl — paid tier (AC-U2)', () => {
	const object: ObjectRow = {
		id: OBJ_A,
		workspaceId: WS_A,
		type: 'bet',
		title: 'Ship the compact unfurl',
		status: 'active',
		driver: DRIVER_ACTOR,
	}

	it('renders three-line compact unfurl with static_select chips on paid tier', async () => {
		const { buildCompactUnfurl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const { blocks } = buildCompactUnfurl({
			object,
			driverName: 'Alice',
			statuses: ['signal', 'active', 'paused', 'succeeded', 'failed'],
			drivers: [
				{ actorId: DRIVER_ACTOR, name: 'Alice' },
				{ actorId: OTHER_ACTOR, name: 'Bob' },
			],
			tier: 'paid',
			baseUrl: BASE_URL,
		})

		// Line 1 (Slack renders app row itself). Line 2 = title + overflow.
		expect(blocks[0]?.type).toBe('section')
		const titleText = (blocks[0] as { text: { text: string } }).text.text
		expect(titleText).toContain(`<${BASE_URL}/${WS_A}/objects/${OBJ_A}|Ship the compact unfurl>`)
		expect(titleText.startsWith('*')).toBe(true)
		const overflow = (blocks[0] as { accessory: { type: string; options: unknown[] } }).accessory
		expect(overflow.type).toBe('overflow')
		expect(overflow.options).toHaveLength(3)

		// Line 3 = actions block carrying the T6 contract block_id + chip row.
		const actions = blocks[1] as {
			type: string
			block_id: string
			elements: Array<Record<string, unknown>>
		}
		expect(actions.type).toBe('actions')
		expect(actions.block_id).toBe(`obj:${WS_A}:${OBJ_A}`)

		// Four chips: type / status / driver / comment.
		expect(actions.elements).toHaveLength(4)
		const [typeChip, statusChip, driverChip, commentChip] = actions.elements as Array<{
			type: string
			text?: { text: string }
			action_id?: string
			placeholder?: { text: string }
			initial_option?: { value: string }
			options?: Array<{ value: string }>
			url?: string
		}>
		expect(typeChip?.type).toBe('button')
		expect(typeChip?.text?.text).toBe('● bet')
		expect(typeChip?.url).toBe(`${BASE_URL}/${WS_A}/objects/${OBJ_A}`)

		expect(statusChip?.type).toBe('static_select')
		expect(statusChip?.action_id).toBe('status_select')
		expect(statusChip?.initial_option?.value).toBe('active')
		expect(statusChip?.options?.map((o) => o.value)).toEqual([
			'signal',
			'active',
			'paused',
			'succeeded',
			'failed',
		])

		expect(driverChip?.type).toBe('static_select')
		expect(driverChip?.action_id).toBe('driver_select')
		expect(driverChip?.initial_option?.value).toBe(DRIVER_ACTOR)
		// First option is the Unassigned sentinel (empty string value).
		expect(driverChip?.options?.[0]?.value).toBe('')
		expect(driverChip?.options?.some((o) => o.value === DRIVER_ACTOR)).toBe(true)

		expect(commentChip?.type).toBe('button')
		expect(commentChip?.text?.text).toBe('💬 Comment')
		expect(commentChip?.url).toBe(`${BASE_URL}/${WS_A}/objects/${OBJ_A}#comments`)

		// No free-tier context hint.
		expect(blocks.some((b) => b.type === 'context')).toBe(false)
	})

	it('injects the current status into options if not in the configured list', async () => {
		const { buildCompactUnfurl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const { blocks } = buildCompactUnfurl({
			object: { ...object, status: 'legacy_status' },
			driverName: 'Alice',
			statuses: ['signal', 'active'],
			drivers: [],
			tier: 'paid',
			baseUrl: BASE_URL,
		})
		const actions = blocks[1] as { elements: Array<{ options?: Array<{ value: string }> }> }
		const statusChip = actions.elements[1]
		expect(statusChip?.options?.map((o) => o.value)).toContain('legacy_status')
	})
})

describe('buildCompactUnfurl — free tier (AC-U4)', () => {
	const object: ObjectRow = {
		id: OBJ_A,
		workspaceId: WS_A,
		type: 'task',
		title: 'Free tier degrade',
		status: 'todo',
		driver: null,
	}

	it('swaps static_selects for ↗ deep-link buttons and appends the muted caption', async () => {
		const { buildCompactUnfurl } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const { blocks } = buildCompactUnfurl({
			object,
			driverName: null,
			statuses: ['todo', 'in_progress', 'done'],
			drivers: [{ actorId: DRIVER_ACTOR, name: 'Alice' }],
			tier: 'free',
			baseUrl: BASE_URL,
		})

		const actions = blocks[1] as { elements: Array<Record<string, unknown>> }
		expect(actions.elements).toHaveLength(4)
		// Every editable chip is a button in free mode.
		for (const el of actions.elements) {
			expect((el as { type: string }).type).toBe('button')
		}
		const [, statusChip, driverChip] = actions.elements as Array<{
			text: { text: string }
			url: string
		}>
		expect(statusChip?.text?.text).toBe('◐ todo ↗')
		expect(statusChip?.url).toBe(`${BASE_URL}/${WS_A}/objects/${OBJ_A}?edit=status`)
		expect(driverChip?.text?.text).toBe('👤 Unassigned ↗')
		expect(driverChip?.url).toBe(`${BASE_URL}/${WS_A}/objects/${OBJ_A}?edit=driver`)

		// Rule 4: never a full-card yellow upgrade banner — one muted context line.
		const contextBlocks = blocks.filter((b) => b.type === 'context') as Array<{
			elements: Array<{ text: string }>
		}>
		expect(contextBlocks).toHaveLength(1)
		expect(contextBlocks[0]?.elements[0]?.text).toBe('_Inline edit needs Slack Pro._')
	})
})

describe('submitLinkSharedUnfurls — end-to-end contract', () => {
	const fetchMock = vi.fn()

	beforeEach(() => {
		getValidTokenMock.mockReset().mockResolvedValue('xoxb-test')
		fetchMock.mockReset().mockResolvedValue({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ ok: true }),
		})
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function integrationWithTier(tier: 'paid' | 'free') {
		return {
			id: 'int-1',
			config: {
				slackTierCache: { tier, fetchedAt: Date.now() },
			},
		}
	}

	it('paid tier: builds a static_select unfurl and calls chat.unfurl', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: { actorId: ACTOR_A },
			integration: integrationWithTier('paid'),
			memberOfWorkspaces: [WS_A],
			objects: [
				{
					id: OBJ_A,
					workspaceId: WS_A,
					type: 'bet',
					title: 'Ship it',
					status: 'active',
					driver: DRIVER_ACTOR,
				},
			],
			workspaceSettings: {
				statuses: {
					bet: ['signal', 'active', 'succeeded', 'failed'],
				},
			},
			workspaceMembers: [
				{ actorId: DRIVER_ACTOR, name: 'Alice' },
				{ actorId: OTHER_ACTOR, name: 'Bob' },
			],
			drivers: [{ id: DRIVER_ACTOR, name: 'Alice' }],
		})

		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000100',
				user: 'U1',
				links: [{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_A}`, domain: 'maskin.io' }],
			},
		})

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const call = fetchMock.mock.calls[0]
		expect(call?.[0]).toContain('chat.unfurl')
		const body = JSON.parse((call?.[1] as { body: string }).body) as {
			channel: string
			ts: string
			unfurls: Record<string, { blocks: Array<Record<string, unknown>> }>
		}
		expect(body.channel).toBe('C1')
		expect(body.ts).toBe('1700000000.000100')
		const unfurl = body.unfurls[`${BASE_URL}/${WS_A}/objects/${OBJ_A}`]
		expect(unfurl).toBeDefined()
		const actions = unfurl?.blocks[1] as {
			block_id: string
			elements: Array<{ type: string; action_id?: string }>
		}
		expect(actions.block_id).toBe(`obj:${WS_A}:${OBJ_A}`)
		expect(actions.elements[1]?.type).toBe('static_select')
		expect(actions.elements[1]?.action_id).toBe('status_select')
		expect(actions.elements[2]?.action_id).toBe('driver_select')
	})

	it('free tier: never blocks and includes the muted context caption', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: { actorId: ACTOR_A },
			integration: integrationWithTier('free'),
			memberOfWorkspaces: [WS_A],
			objects: [
				{
					id: OBJ_A,
					workspaceId: WS_A,
					type: 'task',
					title: 'Free tier link',
					status: 'todo',
					driver: null,
				},
			],
			workspaceSettings: { statuses: { task: ['todo', 'done'] } },
			workspaceMembers: [],
			drivers: [],
		})

		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000101',
				user: 'U1',
				links: [{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_A}`, domain: 'maskin.io' }],
			},
		})

		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
			unfurls: Record<string, { blocks: Array<Record<string, unknown>> }>
		}
		const blocks = body.unfurls[`${BASE_URL}/${WS_A}/objects/${OBJ_A}`]?.blocks ?? []
		const actions = blocks[1] as { elements: Array<{ type: string }> }
		for (const el of actions.elements) expect(el.type).toBe('button')
		const contextBlock = blocks.find((b) => b.type === 'context') as {
			elements: Array<{ text: string }>
		}
		expect(contextBlock?.elements[0]?.text).toBe('_Inline edit needs Slack Pro._')
	})

	it('skips the entire batch when the sharing Slack user is not linked', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: null,
			integration: integrationWithTier('paid'),
			memberOfWorkspaces: [WS_A],
			objects: [
				{
					id: OBJ_A,
					workspaceId: WS_A,
					type: 'bet',
					title: 'Nope',
					status: 'active',
					driver: null,
				},
			],
		})
		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000102',
				user: 'U-unlinked',
				links: [{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_A}`, domain: 'maskin.io' }],
			},
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('drops URLs whose workspace the linked actor is not a member of', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: { actorId: ACTOR_A },
			integration: integrationWithTier('paid'),
			memberOfWorkspaces: [], // not a member of anything
			objects: [],
		})
		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000103',
				user: 'U1',
				links: [{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_A}`, domain: 'maskin.io' }],
			},
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('drops URLs with a foreign hostname before touching the DB', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: { actorId: ACTOR_A },
			integration: integrationWithTier('paid'),
			memberOfWorkspaces: [WS_A],
			objects: [],
		})
		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000104',
				user: 'U1',
				links: [
					{ url: `https://maskin.io.evil.com/${WS_A}/objects/${OBJ_A}`, domain: 'maskin.io' },
				],
			},
		})
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('batches multiple URLs in one chat.unfurl call', async () => {
		const { submitLinkSharedUnfurls } = await import(
			'../../../../lib/integrations/providers/slack/unfurl'
		)
		const db = makeFakeDb({
			link: { actorId: ACTOR_A },
			integration: integrationWithTier('paid'),
			memberOfWorkspaces: [WS_A],
			objects: [
				{
					id: OBJ_A,
					workspaceId: WS_A,
					type: 'bet',
					title: 'A',
					status: 'active',
					driver: null,
				},
				{
					id: OBJ_B,
					workspaceId: WS_A,
					type: 'task',
					title: 'B',
					status: 'todo',
					driver: null,
				},
			],
			workspaceSettings: {
				statuses: { bet: ['active'], task: ['todo', 'done'] },
			},
			workspaceMembers: [],
			drivers: [],
		})
		await submitLinkSharedUnfurls({
			db: db as never,
			integrationId: 'int-1',
			teamId: 'T1',
			baseUrl: BASE_URL,
			event: {
				channel: 'C1',
				message_ts: '1700000000.000105',
				user: 'U1',
				links: [
					{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_A}` },
					{ url: `${BASE_URL}/${WS_A}/objects/${OBJ_B}` },
				],
			},
		})
		expect(fetchMock).toHaveBeenCalledTimes(1)
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as { body: string }).body) as {
			unfurls: Record<string, unknown>
		}
		expect(Object.keys(body.unfurls)).toHaveLength(2)
	})
})

describe('slackEventNormalizer', () => {
	it('recognizes link_shared as slack.link_shared / shared', async () => {
		const { slackEventNormalizer } = await import(
			'../../../../lib/integrations/providers/slack/webhooks'
		)
		const result = slackEventNormalizer(
			{
				type: 'event_callback',
				team_id: 'T1',
				event: {
					type: 'link_shared',
					channel: 'C1',
					message_ts: '1700000000.000110',
					user: 'U1',
					links: [{ url: 'https://maskin.io/x/objects/y', domain: 'maskin.io' }],
				},
			},
			{},
		)
		expect(result?.entityType).toBe('slack.link_shared')
		expect(result?.action).toBe('shared')
		expect(result?.installationId).toBe('T1')
	})
})
