import type { workspaceSettingsSchema } from '@maskin/shared'
import type { z } from 'zod'

/** Typed workspace settings — derived from the shared Zod schema. */
export type WorkspaceSettings = z.infer<typeof workspaceSettingsSchema>

/** Typed integration config stored in the `config` jsonb column. */
export interface IntegrationConfig {
	system_actor_id?: string
	[key: string]: unknown
}
