import { agentGrants, integrations, sessionLogs, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { encrypt } from '../../lib/crypto'
import { seedToolGrants } from '../../lib/integrations/tool-use-seed'
import {
	insertActor,
	insertAgentGrant,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

async function connect(
	workspaceId: string,
	human: string,
	provider: string,
	defaultAccess = 'read',
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider,
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: `fake-${provider}-token-0123456789` })),
			createdBy: human,
			defaultAgentAccess: defaultAccess as 'read',
		})
		.returning()
	return row as typeof integrations.$inferSelect
}

async function newAgent(workspaceId: string, tools: Record<string, unknown> = {}) {
	const agent = await insertActor(db, { type: 'agent', tools })
	await db.insert(workspaceMembers).values({ workspaceId, actorId: agent.id, role: 'member' })
	return agent
}

const call = (tool: string) =>
	JSON.stringify({
		type: 'assistant',
		message: { content: [{ type: 'tool_use', id: 't1', name: tool, input: {} }] },
	})

describe('seedToolGrants', () => {
	it('grants what logs, config and triggers name, at today’s level, and nothing else', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human, { enterpriseGranted: true })
		const gmail = await connect(ws.id, human, 'gmail')
		const slack = await connect(ws.id, human, 'slack')
		const linear = await connect(ws.id, human, 'linear')
		const resend = await connect(ws.id, human, 'resend')
		await connect(ws.id, human, 'ubersuggest', 'none')

		const byLogs = await newAgent(ws.id)
		const session = await insertSession(db, ws.id, byLogs.id, human, { status: 'completed' })
		await db.insert(sessionLogs).values([
			{
				sessionId: session.id,
				stream: 'stdout',
				content: call('mcp__integration-gmail__create_draft'),
			},
			{ sessionId: session.id, stream: 'stdout', content: call('mcp__maskin__get_objects') },
			{ sessionId: session.id, stream: 'stdout', content: call('Bash') },
		])
		// Older sessions logged a server by its provider alone.
		const byBareLog = await newAgent(ws.id)
		const bareSession = await insertSession(db, ws.id, byBareLog.id, human, {
			status: 'completed',
		})
		await db.insert(sessionLogs).values({
			sessionId: bareSession.id,
			stream: 'stdout',
			content: call('mcp__slack__slack_send_message'),
		})
		const byConfig = await newAgent(ws.id, {
			mcpServers: { 'integration-slack': { type: 'http', url: 'https://x' } },
		})
		const byTrigger = await newAgent(ws.id)
		await insertTrigger(db, ws.id, human, byTrigger.id, {
			actionPrompt: 'Send the summary with mcp__integration-linear__create_issue',
		})
		const alreadyGranted = await newAgent(ws.id)
		await insertAgentGrant(db, {
			workspaceId: ws.id,
			integrationId: resend.id,
			actorId: alreadyGranted.id,
			access: 'read_write',
		})
		const s2 = await insertSession(db, ws.id, alreadyGranted.id, human, { status: 'completed' })
		await db.insert(sessionLogs).values({
			sessionId: s2.id,
			stream: 'stdout',
			content: call('mcp__integration-resend__list-emails'),
		})
		const oldLog = await newAgent(ws.id)
		const s3 = await insertSession(db, ws.id, oldLog.id, human, { status: 'completed' })
		await db.insert(sessionLogs).values({
			sessionId: s3.id,
			stream: 'stdout',
			content: call('mcp__integration-ubersuggest__keyword_metrics'),
		})

		const grantsOf = async (actorId: string) =>
			(await db.select().from(agentGrants).where(eq(agentGrants.actorId, actorId))).map(
				(g) => [g.integrationId, g.access] as const,
			)

		const dry = await seedToolGrants(db, { workspaceId: ws.id, dryRun: true })
		expect(await grantsOf(byLogs.id)).toEqual([])
		expect(dry.find((r) => r.actorId === byLogs.id)?.grantsAdded).toEqual(['gmail'])

		await seedToolGrants(db, { workspaceId: ws.id })
		expect(await grantsOf(byLogs.id)).toEqual([[gmail.id, 'read']])
		expect(await grantsOf(byBareLog.id)).toEqual([[slack.id, 'read']])
		expect(await grantsOf(byConfig.id)).toEqual([[slack.id, 'read']])
		expect(await grantsOf(byTrigger.id)).toEqual([[linear.id, 'read']])
		// An existing grant keeps its level, and a default of none stays closed.
		expect(await grantsOf(alreadyGranted.id)).toEqual([[resend.id, 'read_write']])
		expect(await grantsOf(oldLog.id)).toEqual([])

		// A second run changes nothing.
		const again = await seedToolGrants(db, { workspaceId: ws.id })
		expect(again.every((r) => r.grantsAdded.length === 0)).toBe(true)
		const [row] = await db
			.select()
			.from(agentGrants)
			.where(and(eq(agentGrants.actorId, byLogs.id), eq(agentGrants.integrationId, gmail.id)))
		expect(row?.access).toBe('read')
	})

	it('lists what stays attached once defaults are none', async () => {
		const human = getTestActorId()
		const ws = await insertWorkspace(db, human, { enterpriseGranted: true })
		await connect(ws.id, human, 'gmail')
		await connect(ws.id, human, 'slack')
		const agent = await newAgent(ws.id)
		const s = await insertSession(db, ws.id, agent.id, human, { status: 'completed' })
		await db.insert(sessionLogs).values({
			sessionId: s.id,
			stream: 'stdout',
			content: call('mcp__integration-gmail__list_drafts'),
		})
		const [report] = (await seedToolGrants(db, { workspaceId: ws.id })).filter(
			(r) => r.actorId === agent.id,
		)
		expect(report?.attachedToday).toEqual(['gmail', 'slack'])
		expect(report?.attachedAfterDefaultsNone).toEqual(['gmail'])
	})
})
