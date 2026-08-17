import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useSlackConversations, useSlackUsers } from '@/hooks/use-integrations'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { type MultiSelectItem, SearchableMultiSelect } from './searchable-multi-select'

/**
 * UI state for Slack-specific filters. Compiled to/from `config.conditions`
 * by the caller (trigger-form.tsx).
 */
export interface SlackFilterState {
	channelsInclude: string[]
	channelsExclude: string[]
	usersInclude: string[]
	usersExclude: string[]
	reactionsInclude: string[]
	reactionsExclude: string[]
}

export const EMPTY_SLACK_FILTER_STATE: SlackFilterState = {
	channelsInclude: [],
	channelsExclude: [],
	usersInclude: [],
	usersExclude: [],
	reactionsInclude: [],
	reactionsExclude: [],
}

const CONVERSATION_TYPES_BY_ENTITY: Record<string, string[] | undefined> = {
	'slack.channel_message': ['public_channel'],
	'slack.group_message': ['private_channel', 'mpim'],
	'slack.direct_message': ['im'],
	// catch-alls show every conversation type
	'slack.message': ['public_channel', 'private_channel', 'im', 'mpim'],
	'slack.app_mention': ['public_channel', 'private_channel', 'im', 'mpim'],
	'slack.reaction': ['public_channel', 'private_channel', 'im', 'mpim'],
}

function formatConversation(c: {
	id: string
	name: string
	is_im: boolean
	is_mpim: boolean
}): MultiSelectItem {
	let label: string
	if (c.is_im) label = c.name ? `@${c.name}` : `DM ${c.id}`
	else if (c.is_mpim) label = c.name || `Group DM ${c.id}`
	else label = `#${c.name || c.id}`
	return { id: c.id, label, hint: c.id }
}

function formatUser(u: {
	id: string
	name: string
	real_name: string
	is_bot: boolean
}): MultiSelectItem {
	const label = u.real_name ? `${u.real_name} (@${u.name})` : u.name ? `@${u.name}` : u.id
	return { id: u.id, label, hint: u.is_bot ? 'bot' : undefined }
}

interface EmojiListProps {
	value: string[]
	onChange: (next: string[]) => void
	placeholder: string
}

function EmojiList({ value, onChange, placeholder }: EmojiListProps) {
	const [draft, setDraft] = useState('')
	function add() {
		const next = draft.replace(/^:|:$/g, '').trim()
		if (!next || value.includes(next)) {
			setDraft('')
			return
		}
		onChange([...value, next])
		setDraft('')
	}
	function remove(name: string) {
		onChange(value.filter((v) => v !== name))
	}
	return (
		<div className="space-y-2">
			{value.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{value.map((name) => (
						<Badge key={name} variant="secondary" className="gap-1 pr-1">
							<span>:{name}:</span>
							<button
								type="button"
								className="rounded-sm hover:bg-bg-hover"
								onClick={() => remove(name)}
								aria-label={`Remove ${name}`}
							>
								<X size={12} />
							</button>
						</Badge>
					))}
				</div>
			)}
			<div className="flex gap-2">
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') {
							e.preventDefault()
							add()
						}
					}}
					placeholder={placeholder}
					className="h-8 max-w-xs"
				/>
				<Button type="button" variant="outline" size="sm" onClick={add} disabled={!draft.trim()}>
					Add
				</Button>
			</div>
		</div>
	)
}

interface SlackFiltersProps {
	entityType: string
	integrationId: string | undefined
	workspaceId: string
	value: SlackFilterState
	onChange: (next: SlackFilterState) => void
}

export function SlackFilters({
	entityType,
	integrationId,
	workspaceId,
	value,
	onChange,
}: SlackFiltersProps) {
	const conversationTypes = CONVERSATION_TYPES_BY_ENTITY[entityType]
	const { data: conversations, isLoading: convLoading } = useSlackConversations(
		integrationId,
		workspaceId,
		conversationTypes,
	)
	const { data: users, isLoading: usersLoading } = useSlackUsers(integrationId, workspaceId)

	const conversationItems = useMemo(
		() => (conversations ?? []).map(formatConversation),
		[conversations],
	)
	const userItems = useMemo(() => (users ?? []).map(formatUser), [users])

	const isReaction = entityType === 'slack.reaction'

	if (!integrationId) {
		return (
			<div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
				Connect Slack to add channel and user filters.
			</div>
		)
	}

	return (
		<div className="space-y-4">
			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Only fire if in these channels (optional)
				</p>
				<SearchableMultiSelect
					items={conversationItems}
					selectedIds={value.channelsInclude}
					onChange={(ids) => onChange({ ...value, channelsInclude: ids })}
					placeholder="Search channels…"
					emptyText="No channels found. Make sure the bot is invited."
					loading={convLoading}
				/>
			</div>

			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Never fire if in these channels (optional)
				</p>
				<SearchableMultiSelect
					items={conversationItems}
					selectedIds={value.channelsExclude}
					onChange={(ids) => onChange({ ...value, channelsExclude: ids })}
					placeholder="Search channels…"
					emptyText="No channels found."
					loading={convLoading}
				/>
			</div>

			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Only fire if sent by these users (optional)
				</p>
				<SearchableMultiSelect
					items={userItems}
					selectedIds={value.usersInclude}
					onChange={(ids) => onChange({ ...value, usersInclude: ids })}
					placeholder="Search users…"
					emptyText="No users found."
					loading={usersLoading}
				/>
			</div>

			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Never fire if sent by these users (optional)
				</p>
				<SearchableMultiSelect
					items={userItems}
					selectedIds={value.usersExclude}
					onChange={(ids) => onChange({ ...value, usersExclude: ids })}
					placeholder="Search users…"
					emptyText="No users found."
					loading={usersLoading}
				/>
			</div>

			{isReaction && (
				<>
					<div className="space-y-2">
						<p className="text-xs font-medium text-muted-foreground">
							Only fire for these reactions (optional)
						</p>
						<EmojiList
							value={value.reactionsInclude}
							onChange={(next) => onChange({ ...value, reactionsInclude: next })}
							placeholder="Emoji name (e.g. thumbsup)"
						/>
					</div>
					<div className="space-y-2">
						<p className="text-xs font-medium text-muted-foreground">
							Never fire for these reactions (optional)
						</p>
						<EmojiList
							value={value.reactionsExclude}
							onChange={(next) => onChange({ ...value, reactionsExclude: next })}
							placeholder="Emoji name"
						/>
					</div>
				</>
			)}
		</div>
	)
}

// ── Mapping between SlackFilterState and the generic `conditions` array ──────

interface ConditionLike {
	field: string
	operator: string
	value?: unknown
}

const CHANNEL_PATH_BY_ENTITY: Record<string, string | undefined> = {
	'slack.message': 'event.channel',
	'slack.channel_message': 'event.channel',
	'slack.group_message': 'event.channel',
	'slack.direct_message': 'event.channel',
	'slack.app_mention': 'event.channel',
	'slack.reaction': 'event.item.channel',
}

const USER_PATH = 'event.user'
const REACTION_PATH = 'event.reaction'

export function isSlackEntityType(entityType: string | undefined | null): boolean {
	return typeof entityType === 'string' && entityType.startsWith('slack.')
}

export function slackFiltersToConditions(
	entityType: string,
	state: SlackFilterState,
): ConditionLike[] {
	const channelPath = CHANNEL_PATH_BY_ENTITY[entityType]
	const out: ConditionLike[] = []

	if (channelPath) {
		if (state.channelsInclude.length > 0) {
			out.push({ field: channelPath, operator: 'in', value: state.channelsInclude })
		}
		if (state.channelsExclude.length > 0) {
			out.push({ field: channelPath, operator: 'not_in', value: state.channelsExclude })
		}
	}

	if (state.usersInclude.length > 0) {
		out.push({ field: USER_PATH, operator: 'in', value: state.usersInclude })
	}
	if (state.usersExclude.length > 0) {
		out.push({ field: USER_PATH, operator: 'not_in', value: state.usersExclude })
	}

	if (entityType === 'slack.reaction') {
		if (state.reactionsInclude.length > 0) {
			out.push({ field: REACTION_PATH, operator: 'in', value: state.reactionsInclude })
		}
		if (state.reactionsExclude.length > 0) {
			out.push({ field: REACTION_PATH, operator: 'not_in', value: state.reactionsExclude })
		}
	}

	return out
}

export function slackFiltersFromConditions(
	entityType: string,
	conditions: ConditionLike[] | undefined,
): SlackFilterState {
	const state = { ...EMPTY_SLACK_FILTER_STATE }
	if (!conditions) return state
	const channelPath = CHANNEL_PATH_BY_ENTITY[entityType]

	for (const c of conditions) {
		const values = Array.isArray(c.value) ? (c.value as string[]) : []
		if (channelPath && c.field === channelPath) {
			if (c.operator === 'in') state.channelsInclude = values
			if (c.operator === 'not_in') state.channelsExclude = values
		} else if (c.field === USER_PATH) {
			if (c.operator === 'in') state.usersInclude = values
			if (c.operator === 'not_in') state.usersExclude = values
		} else if (c.field === REACTION_PATH) {
			if (c.operator === 'in') state.reactionsInclude = values
			if (c.operator === 'not_in') state.reactionsExclude = values
		}
	}

	return state
}
