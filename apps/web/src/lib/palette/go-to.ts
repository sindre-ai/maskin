// Extra "Go to" destinations beyond the main views: every Settings sub-page and
// Triggers. Typing a page name ("keychain") adds a "Settings › Keychain" row.

import { matches } from './ranking'

export const SETTINGS_ROWS_MAX = 4

export interface SettingsPage {
	label: string
	/** Path below the workspace, e.g. "settings/keychain". */
	path: string
}

export const SETTINGS_PAGES: SettingsPage[] = [
	{ label: 'General', path: 'settings' },
	{ label: 'Objects', path: 'settings/objects' },
	{ label: 'Members', path: 'settings/members' },
	{ label: 'Integrations', path: 'settings/integrations' },
	{ label: 'Extensions', path: 'settings/extensions' },
	{ label: 'Skills', path: 'settings/skills' },
	{ label: 'MCP', path: 'settings/mcp' },
	{ label: 'Billing', path: 'settings/billing' },
	{ label: 'Keys', path: 'settings/keys' },
	{ label: 'Keychain', path: 'settings/keychain' },
]

export const TRIGGERS_PAGE = { title: 'Triggers', path: 'triggers' }

export interface GoToEntry {
	title: string
	path: string
}

export function settingsTitle(page: SettingsPage): string {
	return `Settings › ${page.label}`
}

/** Settings pages whose name matches the query, at most four. Empty for an empty query. */
export function matchSettingsPages(query: string): GoToEntry[] {
	if (!query.trim()) return []
	return SETTINGS_PAGES.filter((page) => matches(query, page.label))
		.slice(0, SETTINGS_ROWS_MAX)
		.map((page) => ({ title: settingsTitle(page), path: page.path }))
}
