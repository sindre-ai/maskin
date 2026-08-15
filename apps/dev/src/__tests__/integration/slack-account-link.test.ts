import { randomBytes, randomUUID } from 'node:crypto'
import { integrations, slackUserLinks, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	dispatchAccountLinkAction,
	dispatchMaskinWorkspaceCommand,
	reapSlackUserLinks,
} from '../../lib/integrations/providers/slack/account-link'
import { db, getTestActorId, sql } from './global-setup'

// Integration coverage for the Slack account-link surface (AC-T2 round-trip
// uses a bot-token in the integration row; AC-T5 reaps link rows on
// disconnect; AC-U3 selector writes a link; AC-U5 re-prompt after revoke is
// represented by the absence of a link row after reap).
//
// `users.info` is mocked at the global fetch boundary — the dispatcher resolves
// the linking actor by Slack email and we don't want a real Slack API
// dependency for CI.

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')
let originalEncryptionKey: string | undefined

beforeAll(() => {
	originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
	process.env.INTEGRATION_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY
})

afterAll(() => {
	if (originalEncryptionKey === undefined) {
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
	} else {
		process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
	}
})

beforeEach(() => {
	vi.restoreAllMocks()
})

function mockUsersInfo(email: string | undefined) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const u = typeof url === 'string' ? url : url.toString()
		if (u.includes('users.info')) {
			return {
				ok: true,
				json: async () => ({
					ok: true,
					user: {
						id: 'U-stubbed',
						profile: email ? { email } : {},
						is_bot: false,
					},
				}),
			} as unknown as Response
		}
		throw new Error(`unexpected fetch in test: ${u}`)
	})
}

async function setupWorkspaceWithSlack(args: {
	teamId: string
	actorEmail: string
	workspaceName: string
}) {
	// Independent actor + workspace so the linking actor is a member of exactly
	// the workspace we're testing routing for.
	const [actor] = await sql`
		INSERT INTO actors (type, name, email, api_key)
		VALUES ('human', 'Link Actor', ${args.actorEmail}, ${`ank_${randomBytes(8).toString('hex')}`})
		RETURNING id
	`
	const [workspace] = await sql`
		INSERT INTO workspaces (name, settings, created_by)
		VALUES (${args.workspaceName}, '{}', ${getTestActorId()})
		RETURNING id
	`
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: workspace.id, actorId: actor.id, role: 'owner' })

	const [integration] = await db
		.insert(integrations)
		.values({
			workspaceId: workspace.id,
			provider: 'slack',
			status: 'active',
			externalId: args.teamId,
			credentials: encrypt(
				JSON.stringify({
					accessToken: `xoxb-${randomBytes(6).toString('hex')}`,
					teamId: args.teamId,
				}),
			),
			config: {},
			createdBy: getTestActorId(),
		})
		.returning()
	return { actor, workspace, integration }
}

describe('dispatchAccountLinkAction (integration)', () => {
	it('writes a slack_user_links row when the user confirms a workspace selection (AC-U3)', async () => {
		const teamId = `T${randomBytes(4).toString('hex')}`
		const slackUserId = `U${randomBytes(4).toString('hex')}`
		const { actor, workspace } = await setupWorkspaceWithSlack({
			teamId,
			actorEmail: 'pick-this@test.com',
			workspaceName: 'Pickable Workspace',
		})

		mockUsersInfo('pick-this@test.com')

		const payload = {
			type: 'block_actions',
			team: { id: teamId },
			user: { id: slackUserId },
			actions: [
				{
					action_id: 'maskin_account_link:confirm',
					block_id: `maskin_account_link:confirm:${teamId}:${slackUserId}`,
					value: 'confirm',
				},
			],
			state: {
				values: {
					[`maskin_account_link:picker:${teamId}:${slackUserId}`]: {
						'maskin_account_link:workspace_select': {
							action_id: 'maskin_account_link:workspace_select',
							selected_option: { value: workspace.id },
						},
					},
					[`maskin_account_link:default:${teamId}:${slackUserId}`]: {
						'maskin_account_link:set_default': {
							action_id: 'maskin_account_link:set_default',
							selected_options: [{ value: 'set_default' }],
						},
					},
				},
			},
		}

		const result = await dispatchAccountLinkAction(db, payload)
		expect(result.kind).toBe('linked')

		const stored = await db
			.select()
			.from(slackUserLinks)
			.where(
				and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)),
			)
		expect(stored).toHaveLength(1)
		expect(stored[0]?.actorId).toBe(actor.id)
		expect(stored[0]?.defaultWorkspaceId).toBe(workspace.id)
	})

	it('refuses to link to a workspace the actor is not a member of', async () => {
		const teamId = `T${randomBytes(4).toString('hex')}`
		const slackUserId = `U${randomBytes(4).toString('hex')}`
		const { workspace } = await setupWorkspaceWithSlack({
			teamId,
			actorEmail: 'authorised@test.com',
			workspaceName: 'Member WS',
		})

		// Different workspace with the same Slack integration but the linking
		// actor is NOT a member — selecting it must be rejected.
		const [otherWorkspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('Other WS', '{}', ${getTestActorId()})
			RETURNING id
		`
		await db.insert(integrations).values({
			workspaceId: otherWorkspace.id,
			provider: 'slack',
			status: 'active',
			externalId: teamId,
			credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-other', teamId })),
			config: {},
			createdBy: getTestActorId(),
		})

		mockUsersInfo('authorised@test.com')

		const payload = {
			type: 'block_actions',
			team: { id: teamId },
			user: { id: slackUserId },
			actions: [
				{
					action_id: 'maskin_account_link:confirm',
					block_id: `maskin_account_link:confirm:${teamId}:${slackUserId}`,
				},
			],
			state: {
				values: {
					[`maskin_account_link:picker:${teamId}:${slackUserId}`]: {
						'maskin_account_link:workspace_select': {
							action_id: 'maskin_account_link:workspace_select',
							selected_option: { value: otherWorkspace.id },
						},
					},
				},
			},
		}

		const result = await dispatchAccountLinkAction(db, payload)
		expect(result.kind).toBe('invalid')
		expect(result.message).toMatch(/not a member/i)

		// Sanity: no link row exists either way, and the legitimate workspace
		// in the test is untouched.
		const rows = await db
			.select()
			.from(slackUserLinks)
			.where(eq(slackUserLinks.slackTeamId, teamId))
		expect(rows).toHaveLength(0)
		expect(workspace.id).not.toBe(otherWorkspace.id)
	})

	it('returns "unhandled" so T6 / other interactive surfaces can chain', async () => {
		const result = await dispatchAccountLinkAction(db, {
			type: 'block_actions',
			team: { id: 'T999' },
			user: { id: 'U999' },
			actions: [
				{
					action_id: 'obj:ws:obj:status_select',
					block_id: 'obj:ws-foo:obj-bar',
					selected_option: { value: 'done' },
				},
			],
		})
		expect(result.kind).toBe('unhandled')
	})
})

describe('dispatchMaskinWorkspaceCommand (integration)', () => {
	it('switches the link row default when the named workspace matches (AC-U3 override)', async () => {
		const teamId = `T${randomBytes(4).toString('hex')}`
		const slackUserId = `U${randomBytes(4).toString('hex')}`
		const { actor, workspace: ws1 } = await setupWorkspaceWithSlack({
			teamId,
			actorEmail: 'switcher@test.com',
			workspaceName: 'First WS',
		})
		// Second workspace for the same team that the actor is also a member of.
		const [ws2] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('Second WS', '{}', ${getTestActorId()})
			RETURNING id
		`
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: ws2.id, actorId: actor.id, role: 'owner' })
		await db.insert(integrations).values({
			workspaceId: ws2.id,
			provider: 'slack',
			status: 'active',
			externalId: teamId,
			credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-ws2', teamId })),
			config: {},
			createdBy: getTestActorId(),
		})

		// Pre-existing link pointing at ws1.
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId,
			actorId: actor.id,
			defaultWorkspaceId: ws1.id,
		})

		const result = await dispatchMaskinWorkspaceCommand(db, {
			team_id: teamId,
			user_id: slackUserId,
			command: '/maskin',
			text: 'workspace Second WS',
		})
		expect(result.updated).toBe(true)
		expect(result.responseText).toMatch(/Second WS/)

		const [row] = await db
			.select()
			.from(slackUserLinks)
			.where(
				and(eq(slackUserLinks.slackTeamId, teamId), eq(slackUserLinks.slackUserId, slackUserId)),
			)
		expect(row?.defaultWorkspaceId).toBe(ws2.id)
	})

	it('lists available workspaces when the user types a name we do not recognise', async () => {
		const teamId = `T${randomBytes(4).toString('hex')}`
		const slackUserId = `U${randomBytes(4).toString('hex')}`
		const { actor, workspace } = await setupWorkspaceWithSlack({
			teamId,
			actorEmail: 'browser@test.com',
			workspaceName: 'Known WS',
		})
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId,
			actorId: actor.id,
			defaultWorkspaceId: workspace.id,
		})

		const result = await dispatchMaskinWorkspaceCommand(db, {
			team_id: teamId,
			user_id: slackUserId,
			command: '/maskin',
			text: 'workspace I do not exist',
		})
		expect(result.updated).toBe(false)
		expect(result.responseText).toMatch(/No Maskin workspace called/i)
		expect(result.responseText).toMatch(/Known WS/)
	})

	it('refuses to switch when no link exists yet — instead points the user back at @mention', async () => {
		const result = await dispatchMaskinWorkspaceCommand(db, {
			team_id: `T${randomBytes(4).toString('hex')}`,
			user_id: `U${randomBytes(4).toString('hex')}`,
			command: '/maskin',
			text: 'workspace Whatever',
		})
		expect(result.updated).toBe(false)
		expect(result.responseText).toMatch(/@mention `@Maskin`/i)
	})
})

describe('reapSlackUserLinks preDisconnect hook (AC-T5)', () => {
	it('deletes link rows whose default_workspace_id points at the disconnecting integration', async () => {
		const teamId = `T${randomBytes(4).toString('hex')}`
		const slackUserId = `U${randomBytes(4).toString('hex')}`
		const { actor, workspace, integration } = await setupWorkspaceWithSlack({
			teamId,
			actorEmail: 'reap-me@test.com',
			workspaceName: 'Reapable WS',
		})
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId,
			actorId: actor.id,
			defaultWorkspaceId: workspace.id,
		})

		// An unrelated link row for the SAME Slack team but routing to a different
		// Maskin workspace must NOT be reaped — that workspace is still connected.
		const [otherWorkspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('Sibling WS', '{}', ${getTestActorId()})
			RETURNING id
		`
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: otherWorkspace.id, actorId: actor.id, role: 'owner' })
		await db.insert(integrations).values({
			workspaceId: otherWorkspace.id,
			provider: 'slack',
			status: 'active',
			externalId: teamId,
			credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-sib', teamId })),
			config: {},
			createdBy: getTestActorId(),
		})
		const otherSlackUser = `U${randomBytes(4).toString('hex')}`
		await db.insert(slackUserLinks).values({
			slackTeamId: teamId,
			slackUserId: otherSlackUser,
			actorId: actor.id,
			defaultWorkspaceId: otherWorkspace.id,
		})

		await reapSlackUserLinks({
			db,
			integrationId: integration.id,
			workspaceId: workspace.id,
		})

		const remaining = await db
			.select()
			.from(slackUserLinks)
			.where(eq(slackUserLinks.slackTeamId, teamId))
		expect(remaining.map((r) => r.defaultWorkspaceId)).toEqual([otherWorkspace.id])
	})

	it('is a no-op when the disconnecting integration has no team id', async () => {
		// Defensive: a Slack integration row that for some reason has no external_id
		// must not nuke the whole table.
		const [workspace] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('No External Id WS', '{}', ${getTestActorId()})
			RETURNING id
		`
		const [integration] = await db
			.insert(integrations)
			.values({
				workspaceId: workspace.id,
				provider: 'slack',
				status: 'active',
				externalId: null,
				credentials: encrypt(JSON.stringify({ accessToken: 'xoxb-orphan' })),
				config: {},
				createdBy: getTestActorId(),
			})
			.returning()

		// Seed an unrelated link to confirm it survives.
		const [survivorActor] = await sql`
			INSERT INTO actors (type, name, email, api_key)
			VALUES ('human', 'Survivor', 'survivor@test.com', ${`ank_${randomBytes(8).toString('hex')}`})
			RETURNING id
		`
		const [survivorWs] = await sql`
			INSERT INTO workspaces (name, settings, created_by)
			VALUES ('Survivor WS', '{}', ${getTestActorId()})
			RETURNING id
		`
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: survivorWs.id, actorId: survivorActor.id, role: 'owner' })
		await db.insert(slackUserLinks).values({
			slackTeamId: 'T-survivor',
			slackUserId: 'U-survivor',
			actorId: survivorActor.id,
			defaultWorkspaceId: survivorWs.id,
		})

		await reapSlackUserLinks({
			db,
			integrationId: integration.id,
			workspaceId: workspace.id,
		})

		const survivors = await db.select().from(slackUserLinks)
		expect(survivors).toHaveLength(1)
		expect(survivors[0]?.slackTeamId).toBe('T-survivor')
	})
})
