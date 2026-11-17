import type { ObjectsFilterModel } from '@/lib/objects-filter-model'

// The first message of the chat that "Create view with agent" opens. The person
// sees it in the message box and can send, edit or clear it: nothing is built
// until they send. Each place says where the view comes from, then the same
// two rules: the page is one self-contained HTML file, and the view shows names,
// status, driver and dates (the data bridge refuses the rest, see view-lists.ts).

export type CreateViewScope =
	| { kind: 'list'; filters: ObjectsFilterModel }
	| { kind: 'object'; id: string; title: string; type: string }
	| { kind: 'flow'; id: string; name: string }

const HOW_TO_BUILD =
	'Build it as one self-contained HTML file (create_file, mime_type text/html), with an empty and an error state for every number. It can only show names, status, driver and dates.'

/** The filters on the Items list, as the plain phrases the agent needs. Empty when none are set. */
export function describeListFilters(filters: ObjectsFilterModel): string[] {
	const parts: string[] = []
	if (filters.status) parts.push(`status ${filters.status}`)
	if (filters.driver) parts.push(`driver ${filters.driver}`)
	for (const [field, value] of Object.entries(filters.metadata)) {
		parts.push(`${field} ${value}`)
	}
	if (filters.q) parts.push(`search "${filters.q}"`)
	if (filters.ids) parts.push('only the items picked from a notification')
	if (filters.includeArchived) parts.push('archived included')
	return parts
}

export function createViewMessage(scope: CreateViewScope): string {
	if (scope.kind === 'flow') {
		return [
			`Create a custom view for the flow "${scope.name}" (id ${scope.id}).`,
			HOW_TO_BUILD,
			`Then pin it as a tab on this flow with set_loop_view (loop_id ${scope.id}).`,
		].join('\n\n')
	}
	if (scope.kind === 'object') {
		return [
			`Create a custom view for the ${scope.type} "${scope.title}" (id ${scope.id}).`,
			HOW_TO_BUILD,
			'Then pin it to Favorites in the left nav by adding the file id to the workspace pinned_files setting.',
		].join('\n\n')
	}
	const type = scope.filters.type
	const applied = describeListFilters(scope.filters)
	const filterLine =
		applied.length > 0
			? `Filters on the list right now: ${applied.join(', ')}.`
			: 'No filters are set on the list.'
	return [
		`Create a custom view of ${type ? `the ${type} items` : 'the items'} in this workspace, like the Items list I am looking at.`,
		filterLine,
		HOW_TO_BUILD,
		'Then pin it to Favorites in the left nav by adding the file id to the workspace pinned_files setting.',
	].join('\n\n')
}

export const CREATE_VIEW_LABEL = 'Create view with agent'
export const CREATE_VIEW_AGENT_NAME = 'Design Studio'

/** Navigation target for New chat: Design Studio in "To", the message filled in, nothing sent. */
export function createViewChatLink(
	workspaceId: string,
	agent: { id: string; name: string },
	scope: CreateViewScope,
) {
	const attach =
		scope.kind === 'object'
			? { objectId: scope.id, objectTitle: scope.title, objectType: scope.type }
			: scope.kind === 'flow'
				? { objectId: scope.id, objectTitle: scope.name, objectType: 'loop' }
				: {}
	return {
		to: '/$workspaceId/chats/new' as const,
		params: { workspaceId },
		search: { agentId: agent.id, agentName: agent.name, text: createViewMessage(scope), ...attach },
	}
}

/** The menu callback for an item's page: nothing when the item should not show. */
export function createViewRequest(
	open: ((scope: CreateViewScope) => void) | null,
	object: { id: string; title: string | null; type: string },
): (() => void) | undefined {
	if (!open) return undefined
	return () =>
		open({ kind: 'object', id: object.id, title: object.title ?? 'Untitled', type: object.type })
}
