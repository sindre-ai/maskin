import { Activity, Bot, Layers, type LucideIcon, MessagesSquare, Settings, Zap } from 'lucide-react'

export interface PageDefinition {
	id: string
	label: string
	description: string
	category: 'workspace' | 'library' | 'settings'
	to: string
	exact?: boolean
	icon: LucideIcon
	/** If true, only show this page when enabled modules provide object types */
	requiresModuleObjectTypes?: boolean
}

export const ALL_PAGES: PageDefinition[] = [
	{
		id: 'pulse',
		label: 'Pulse',
		description: 'Glanceable digest — what shipped, agents working, and what needs your attention.',
		category: 'workspace',
		to: '/$workspaceId',
		exact: true,
		icon: Zap,
	},
	{
		id: 'threads',
		label: 'Threads',
		description: 'Channel where humans and agents discuss decisions and notifications.',
		category: 'workspace',
		to: '/$workspaceId/threads',
		icon: MessagesSquare,
	},
	{
		id: 'objects',
		label: 'Objects',
		description: 'Workspace objects — insights, bets, and tasks managed by your agents.',
		category: 'workspace',
		to: '/$workspaceId/objects',
		icon: Layers,
		requiresModuleObjectTypes: true,
	},
	{
		id: 'activity',
		label: 'Activity',
		description: 'Full audit log of everything agents and people have done.',
		category: 'library',
		to: '/$workspaceId/activity',
		icon: Activity,
	},
	{
		id: 'agents',
		label: 'Agents',
		description: 'Manage and monitor the autonomous agents in your workspace.',
		category: 'library',
		to: '/$workspaceId/agents',
		icon: Bot,
	},
	{
		id: 'triggers',
		label: 'Triggers',
		description: 'Automations that kick off agent runs on a schedule or event.',
		category: 'library',
		to: '/$workspaceId/triggers',
		icon: Zap,
	},
	{
		id: 'settings',
		label: 'Settings',
		description: 'Workspace settings — members, integrations, MCP servers, and more.',
		category: 'settings',
		to: '/$workspaceId/settings',
		icon: Settings,
	},
]

export const DEFAULT_PINNED_IDS = ['pulse', 'threads', 'activity', 'agents', 'triggers']

const STORAGE_KEY = (workspaceId: string) => `maskin-pinned-pages-${workspaceId}`

export function getPinnedPageIds(workspaceId: string): string[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY(workspaceId))
		if (!raw) return DEFAULT_PINNED_IDS
		const parsed = JSON.parse(raw)
		if (!Array.isArray(parsed)) return DEFAULT_PINNED_IDS
		return parsed.filter((id): id is string => typeof id === 'string')
	} catch {
		return DEFAULT_PINNED_IDS
	}
}

export function setPinnedPageIds(workspaceId: string, ids: string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY(workspaceId), JSON.stringify(ids))
	} catch {
		// ignore storage errors (e.g. private browsing quota)
	}
}

export function getPageById(id: string): PageDefinition | undefined {
	return ALL_PAGES.find((p) => p.id === id)
}

export function getPagesByCategory(): Map<string, PageDefinition[]> {
	const map = new Map<string, PageDefinition[]>()
	for (const page of ALL_PAGES) {
		const existing = map.get(page.category) ?? []
		existing.push(page)
		map.set(page.category, existing)
	}
	return map
}

export const CATEGORY_LABELS: Record<PageDefinition['category'], string> = {
	workspace: 'Workspace',
	library: 'Library',
	settings: 'Settings',
}
