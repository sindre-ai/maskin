import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { workspaces } from '@maskin/db/schema'
import {
	type Guardrails,
	SEND_PERMISSION_KINDS,
	type SendPermissionKind,
	guardrailsSchema,
	storedDailyBudgetSchema,
	toPercentBudget,
} from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { resolveWorkspaceCapCents } from '../lib/daily-budget'
import { createApiError, validationFailureHook } from '../lib/errors'
import { describeAgentAccess } from '../lib/integrations/agent-access-view'
import { errorSchema, workspaceIdHeader } from '../lib/openapi-schemas'
import { type EffectiveSendSetting, loadSendSettings } from '../lib/send-permissions'

// Autonomy and guardrails, first slice: one read of the limits that exist today. It stores
// nothing and checks nothing; each value comes from where it already lives and is read the way
// the code that enforces it reads it. A limit that nothing enforces says so (the daily target
// only reports), so a screen built on this never shows a promise the app does not keep.

type Env = {
	Variables: {
		db: Database
		actorId: string
	}
}

const app = new OpenAPIHono<Env>({ defaultHook: validationFailureHook })

const sendList = (settings: Record<SendPermissionKind, EffectiveSendSetting>) =>
	SEND_PERMISSION_KINDS.map((kind) => ({ kind, ...settings[kind] }))

const route = createRoute({
	method: 'get',
	path: '/',
	tags: ['Agents'],
	summary: 'What each agent may do without asking',
	description:
		'The workspace’s send defaults and daily target, and for each agent its send mode per kind of draft and how many integrations it has at each access level. Any member can read it. Read only: change a send mode with PUT /api/send-permissions and access on the Integrations page.',
	request: { headers: workspaceIdHeader },
	responses: {
		200: {
			content: { 'application/json': { schema: guardrailsSchema } },
			description: 'The limits in force',
		},
		404: { content: { 'application/json': { schema: errorSchema } }, description: 'No workspace' },
	},
})

app.openapi(route, async (c) => {
	const db = c.get('db')
	const { 'x-workspace-id': workspaceId } = c.req.valid('header')

	const [[workspace], send] = await Promise.all([
		db
			.select({
				settings: workspaces.settings,
				enterpriseGranted: workspaces.enterpriseGranted,
				billingOwnerId: workspaces.billingOwnerId,
			})
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.limit(1),
		loadSendSettings(db, workspaceId),
	])
	if (!workspace) return c.json(createApiError('NOT_FOUND', 'Workspace not found'), 404)

	// The target is shown in percent of the plan like everywhere else; one saved in tokens or
	// dollars before that is converted on read, the same way GET /api/billing/daily-budget does.
	const stored = storedDailyBudgetSchema.safeParse(
		(workspace.settings as { daily_budget?: unknown } | null)?.daily_budget,
	)
	const budget = stored.success
		? toPercentBudget(stored.data, resolveWorkspaceCapCents(workspace)).budget
		: null

	const agents = await Promise.all(
		send.agents.map(async (agent) => {
			const view = await describeAgentAccess(db, workspaceId, agent.agentId)
			const count = (level: 'read_write' | 'read' | 'none') =>
				view.integrations.filter((i) => i.access === level).length
			return {
				agent_id: agent.agentId,
				name: agent.name,
				send: sendList(agent.settings),
				access: {
					read_write: count('read_write'),
					read: count('read'),
					none: count('none'),
					credentials: view.credentials.filter((cred) => cred.has_access).length,
				},
			}
		}),
	)

	const body: Guardrails = {
		workspace: {
			daily_budget: budget
				? {
						unit: budget.unit,
						amount: budget.amount,
						stop_share: budget.stop_share,
						timezone: budget.timezone,
					}
				: null,
			// dailyBudgetSchema says it too: nothing reads stop_share, the target only reports.
			daily_budget_enforced: false,
			send_defaults: sendList(send.defaults),
		},
		agents,
	}
	return c.json(body, 200)
})

export default app
