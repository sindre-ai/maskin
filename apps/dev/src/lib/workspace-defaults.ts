import { applyModuleDefaults } from '@maskin/module-sdk'
import { workspaceSettingsSchema } from '@maskin/shared'
import type { WorkspaceSettings } from './types'

/**
 * Build the settings for a brand-new workspace.
 *
 * Parses whatever the caller supplied (filling in the schema defaults, which
 * include `enabled_modules: ['work', 'knowledge', 'crm']`) and then folds in
 * each enabled module's own `defaultSettings` — display names, statuses, field
 * definitions and relationship types. Without that second step a new workspace
 * would list Articles/Contacts/Companies tabs with no statuses behind them,
 * i.e. a state you could never reach by toggling the extension on in
 * Settings → Extensions, which does the same merge (see `ExtensionsManager`).
 *
 * Caller-supplied values always win over module defaults.
 */
export function buildNewWorkspaceSettings(raw?: unknown): WorkspaceSettings {
	const settings = workspaceSettingsSchema.parse(raw ?? {})
	return applyModuleDefaults(settings, settings.enabled_modules)
}
