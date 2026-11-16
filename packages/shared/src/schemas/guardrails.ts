import { z } from 'zod'
import { dailyBudgetUnitSchema } from './daily-budget'

/**
 * Autonomy and guardrails, first slice: a read of the limits that already exist, gathered in one
 * place. Nothing here is stored for the page. Each value is read from where it already lives
 * (send permissions, integration access, the daily target) and says whether anything enforces it,
 * so the page never promises a limit that nothing checks.
 */
export const guardrailSendSettingSchema = z.object({
	/** The kind of draft: email, a LinkedIn message, a Slack message, and so on. */
	kind: z.string(),
	mode: z.enum(['always_allow', 'ask_first', 'deny']),
	/** Where the mode came from: the agent's own setting, the workspace default, or the starting table. */
	source: z.enum(['agent', 'workspace', 'starting']),
})

export const guardrailsSchema = z.object({
	workspace: z.object({
		/** The daily target in percent of the plan (an older token or dollar target is converted), or null when none is set. */
		daily_budget: z
			.object({
				unit: dailyBudgetUnitSchema,
				amount: z.number(),
				stop_share: z.number().int(),
				timezone: z.string(),
			})
			.nullable(),
		/** False today: the target only reports usage, nothing stops a session at the share. */
		daily_budget_enforced: z.boolean(),
		send_defaults: z.array(guardrailSendSettingSchema),
	}),
	agents: z.array(
		z.object({
			agent_id: z.string().uuid(),
			name: z.string(),
			send: z.array(guardrailSendSettingSchema),
			/** How many connected integrations and tool servers the agent has at each level. */
			access: z.object({
				read_write: z.number().int().nonnegative(),
				read: z.number().int().nonnegative(),
				none: z.number().int().nonnegative(),
				/** Saved keys and logins the agent may use. */
				credentials: z.number().int().nonnegative(),
			}),
		}),
	),
})

export type Guardrails = z.infer<typeof guardrailsSchema>
