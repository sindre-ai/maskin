import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Hoisted mocks ────────────────────────────────────────────────────────────
// TokenManager + registry are mocked so the mention handler runs against an
// in-memory fake DB; slackPost is mocked so we observe what hits the network
// without ever issuing a fetch.

const getValidTokenMock = vi.hoisted(() => vi.fn<() => Promise<string>>())
const slackPostMock = vi.hoisted(() => vi.fn<() => Promise<unknown>>())

vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'slack' } })),
}))

vi.mock('../../../../lib/integrations/providers/slack/client', () => ({
	slackPost: slackPostMock,
}))

vi.mock('../../../../lib/file-urls', () => ({
	frontendBaseUrl: () => 'https://maskin.test',
}))

vi.mock('@maskin/db/schema', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('@maskin/db/schema')
	return {
		...actual,
		slackUserLinks: { __slackUserLinks: true },
		actors: { __actors: true },
		workspaceMembers: { __workspaceMembers: true },
		integrations: { __integrations: true },
	}
})

vi.mock('drizzle-orm', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('drizzle-orm')
	return { ...actual, eq: () => true, and: () => true }
})

import {
	MENTION_ENTITY_TYPES,
	buildUnlinkedAckBlocks,
	buildWorkingAckBlocks,
	extractMentionFields,
	handleSlackMention,
	isMentionEntityType,
} from '../../../../lib/integrations/providers/slack/mention'

interface FakeLink {
	actorId: string
	defaultWorkspaceId: string
}

interface FakeCoach {
	id: string
	name: string
}

function tableTag(table: unknown): string {
	if (table && typeof table === 'object') {
		const t = table as Record<string, unknown>
		if (t.__slackUserLinks) return 'slack_user_links'
		if (t.__actors) return 'actors'
		if (t.__integrations) return 'integrations'
	}
	return 'unknown'
}

interface MakeFakeDbArgs {
	link?: FakeLink | null
	coach?: FakeCoach | null
	updateThrows?: Error
}

function makeFakeDb(args: MakeFakeDbArgs = {}) {
	const updates: Array<{ table: string; set: unknown }> = []
	const selects: Array<{ table: string }> = []

	const db = {
		select: (_cols?: unknown) => ({
			from: (table: unknown) => {
				const tag = tableTag(table)
				selects.push({ table: tag })
				if (tag === 'slack_user_links') {
					return {
						where: () => ({
							limit: () => Promise.resolve(args.link ? [args.link] : []),
						}),
					}
				}
				if (tag === 'actors') {
					return {
						innerJoin: () => ({
							where: () => ({
								limit: () => Promise.resolve(args.coach ? [args.coach] : []),
							}),
						}),
					}
				}
				return { where: () => ({ limit: () => Promise.resolve([]) }) }
			},
		}),
		update: (table: unknown) => ({
			set: (values: unknown) => ({
				where: () => {
					if (args.updateThrows) throw args.updateThrows
					updates.push({ table: tableTag(table), set: values })
					return Promise.resolve()
				},
			}),
		}),
	}

	return { db, updates, selects }
}

const baseArgs = (overrides: Partial<Parameters<typeof handleSlackMention>[0]> = {}) => ({
	integrationId: 'int-1',
	workspaceId: 'ws-1',
	teamId: 'T123',
	slackUserId: 'U999',
	channel: 'C111',
	threadTs: '1700000000.000001',
	...overrides,
})

describe('extractMentionFields', () => {
	it('pulls team / user / channel / thread for app_mention', () => {
		const result = extractMentionFields({
			team_id: 'T1',
			event: { user: 'U1', channel: 'C1', ts: '1.0' },
		})
		expect(result).toEqual({ teamId: 'T1', slackUserId: 'U1', channel: 'C1', threadTs: '1.0' })
	})
	it('prefers thread_ts over ts when both are present', () => {
		const result = extractMentionFields({
			team_id: 'T1',
			event: { user: 'U1', channel: 'C1', ts: '2.0', thread_ts: '1.0' },
		})
		expect(result?.threadTs).toBe('1.0')
	})
	it('skips bot-authored messages (avoids ack loop)', () => {
		expect(
			extractMentionFields({
				team_id: 'T1',
				event: { user: 'U_BOT', channel: 'D1', ts: '1.0', bot_id: 'B1' },
			}),
		).toBeNull()
		expect(
			extractMentionFields({
				team_id: 'T1',
				event: {
					user: 'U_BOT',
					channel: 'D1',
					ts: '1.0',
					bot_profile: { id: 'B1', name: 'someone' },
				},
			}),
		).toBeNull()
	})
	it('skips message_changed / message_deleted / channel_join subtypes', () => {
		for (const subtype of ['message_changed', 'message_deleted', 'bot_message', 'channel_join']) {
			expect(
				extractMentionFields({
					team_id: 'T1',
					event: { user: 'U1', channel: 'C1', ts: '1.0', subtype },
				}),
			).toBeNull()
		}
	})
	it('returns null when envelope is shaped wrong', () => {
		expect(extractMentionFields({})).toBeNull()
		expect(extractMentionFields({ team_id: 'T1' })).toBeNull()
		expect(extractMentionFields({ team_id: 'T1', event: { channel: 'C1' } })).toBeNull()
		expect(extractMentionFields({ team_id: 'T1', event: { user: 'U1' } })).toBeNull()
	})
})

describe('isMentionEntityType', () => {
	it('recognises both mention surfaces', () => {
		expect(isMentionEntityType('slack.app_mention')).toBe(true)
		expect(isMentionEntityType('slack.direct_message')).toBe(true)
	})
	it('excludes other Slack entities', () => {
		expect(isMentionEntityType('slack.channel_message')).toBe(false)
		expect(isMentionEntityType('slack.group_message')).toBe(false)
		expect(isMentionEntityType('slack.app_home_opened')).toBe(false)
	})
	it('matches the exported tuple', () => {
		expect([...MENTION_ENTITY_TYPES]).toEqual(['slack.app_mention', 'slack.direct_message'])
	})
})

describe('buildWorkingAckBlocks / buildUnlinkedAckBlocks', () => {
	it('carries the Falu-red agent subscript on the working ack', () => {
		const blocks = buildWorkingAckBlocks('Workspace Coach')
		const subscript = blocks.find((b) => b.type === 'context') as
			| { elements: Array<{ text: string }> }
			| undefined
		expect(subscript?.elements?.[0]?.text).toContain('↳ Workspace Coach')
		expect(subscript?.elements?.[0]?.text).toContain('#7C1F1A')
	})
	it('routes unlinked users to the maskin → slack link page and includes subscript', () => {
		const blocks = buildUnlinkedAckBlocks('Workspace Coach')
		const text = JSON.stringify(blocks)
		expect(text).toContain('https://maskin.test/integrations/slack')
		expect(text).toContain('↳ Workspace Coach')
	})
})

describe('handleSlackMention', () => {
	beforeEach(() => {
		getValidTokenMock.mockReset()
		slackPostMock.mockReset()
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('AC-U1: posts the in-thread working ack with chat:write.customize when the user is linked', async () => {
		getValidTokenMock.mockResolvedValue('xoxb-bot-token')
		slackPostMock.mockResolvedValue({ ok: true })
		const { db } = makeFakeDb({
			link: { actorId: 'actor-1', defaultWorkspaceId: 'ws-1' },
			coach: { id: 'coach-1', name: 'Workspace Coach' },
		})
		await handleSlackMention({ db: db as never, ...baseArgs() })

		expect(slackPostMock).toHaveBeenCalledTimes(1)
		const [path, token, body] = slackPostMock.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(path).toBe('chat.postEphemeral')
		expect(token).toBe('xoxb-bot-token')
		expect(body.channel).toBe('C111')
		expect(body.user).toBe('U999')
		expect(body.thread_ts).toBe('1700000000.000001')
		expect(body.username).toBe('Workspace Coach')
		expect(JSON.stringify(body.blocks)).toContain('↳ Workspace Coach')
		expect(JSON.stringify(body.blocks)).toContain('Working')
	})

	it('AC-T2: refuses to post when the stored token is not a bot token', async () => {
		getValidTokenMock.mockResolvedValue('xoxp-user-token')
		const { db, updates } = makeFakeDb({ link: { actorId: 'a', defaultWorkspaceId: 'w' } })
		await handleSlackMention({ db: db as never, ...baseArgs() })
		expect(slackPostMock).not.toHaveBeenCalled()
		expect(updates).toHaveLength(0)
	})

	it('hands off unlinked users to the account-link page (T2)', async () => {
		getValidTokenMock.mockResolvedValue('xoxb-bot-token')
		slackPostMock.mockResolvedValue({ ok: true })
		const { db } = makeFakeDb({ link: null })
		await handleSlackMention({ db: db as never, ...baseArgs() })
		expect(slackPostMock).toHaveBeenCalledTimes(1)
		const [, , body] = slackPostMock.mock.calls[0] as [string, string, Record<string, unknown>]
		expect(JSON.stringify(body.blocks)).toContain('https://maskin.test/integrations/slack')
	})

	it('AC-U5: flips integration to revoked on token_revoked from chat.postEphemeral and stops', async () => {
		getValidTokenMock.mockResolvedValue('xoxb-bot-token')
		slackPostMock.mockRejectedValue(new Error('Slack chat.postEphemeral failed: token_revoked'))
		const { db, updates } = makeFakeDb({
			link: { actorId: 'a', defaultWorkspaceId: 'w' },
			coach: { id: 'c', name: 'Workspace Coach' },
		})
		await handleSlackMention({ db: db as never, ...baseArgs() })
		expect(updates).toEqual([
			{ table: 'integrations', set: expect.objectContaining({ status: 'revoked' }) },
		])
	})

	it('AC-U5: flips integration to revoked on token failure at TokenManager and never calls Slack', async () => {
		getValidTokenMock.mockRejectedValue(new Error('invalid_auth'))
		const { db, updates } = makeFakeDb({ link: null })
		await handleSlackMention({ db: db as never, ...baseArgs() })
		expect(slackPostMock).not.toHaveBeenCalled()
		expect(updates).toEqual([
			{ table: 'integrations', set: expect.objectContaining({ status: 'revoked' }) },
		])
	})

	it('logs and swallows transient Slack errors so the event still lands', async () => {
		getValidTokenMock.mockResolvedValue('xoxb-bot-token')
		slackPostMock.mockRejectedValue(new Error('Slack chat.postEphemeral failed: ratelimited'))
		const { db, updates } = makeFakeDb({
			link: { actorId: 'a', defaultWorkspaceId: 'w' },
			coach: { id: 'c', name: 'Workspace Coach' },
		})
		await expect(handleSlackMention({ db: db as never, ...baseArgs() })).resolves.toBeUndefined()
		expect(updates).toEqual([])
	})

	it('falls back to the literal label when the workspace has no entry agent seeded', async () => {
		getValidTokenMock.mockResolvedValue('xoxb-bot-token')
		slackPostMock.mockResolvedValue({ ok: true })
		const { db } = makeFakeDb({ link: { actorId: 'a', defaultWorkspaceId: 'w' }, coach: null })
		await handleSlackMention({ db: db as never, ...baseArgs() })
		const [, , body] = slackPostMock.mock.calls[0] as [string, string, Record<string, unknown>]
		expect(body.username).toBe('Chief of Staff')
		expect(JSON.stringify(body.blocks)).toContain('↳ Chief of Staff')
	})
})
