import type { workspaceSettingsSchema } from '@maskin/shared'
import type { z } from 'zod'

/** Typed workspace settings — derived from the shared Zod schema. */
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>

/** Typed integration config stored in the `config` jsonb column. */
export interface IntegrationConfig {
	system_actor_id?: string
	owner_login?: string
	/**
	 * When `false`, session-manager injects neither this integration's token env
	 * var nor its auto-inject MCP server into agent sessions. Server-side callers
	 * (webhooks, hooks) still use the stored credential. Absent means `true`.
	 */
	expose_to_agent_sessions?: boolean
	[key: string]: unknown
}
