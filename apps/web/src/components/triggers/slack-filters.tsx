import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useSlackConversations, useSlackUsers } from '@/hooks/use-integrations'
import type { SlackConversation } from '@/lib/api'
import { capture } from '@/lib/posthog'
import { AlertCircle, X } from 'lucide-react'
import type * as React from 'react'
import { useMemo, useState } from 'react'
import { type MultiSelectItem, SearchableMultiSelect } from './searchable-multi-select'

const SLACK_SETUP_UX_V2_FLAG = 'slack-setup-ux-v2'

const NON_MEMBER_TOOLTIP =
	'Bot not in this channel — auto-joins on save (public) or requires invite (private).'

const EMPTY_CHANNELS_COPY_V2 =
	"No channels match — the bot lists every public channel and every private channel it's been invited to."

const ERROR_COPY_V2 = "Couldn't list Slack channels — reconnect Slack from Integrations."

const TRUNCATION_FOOTER_V2 = 'Showing 2000 of many — type to filter.'

// Matches `MAX_PAGES * PAGE_LIMIT` in apps/dev/src/lib/integrations/providers/slack/client.ts.
// When the picker sees this many items, the workspace has more channels than the
// server-side pager surfaces; warn the user in the popover.
const CHANNEL_TRUNCATION_LIMIT = 2000

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
								className="rounded-sm hover:bg-accent"
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
	const {
		data: conversations,
		isLoading: convLoading,
		isError: convError,
	} = useSlackConversations(integrationId, workspaceId, conversationTypes)
	const { data: users, isLoading: usersLoading } = useSlackUsers(integrationId, workspaceId)

	const conversationItems = useMemo(
		() => (conversations ?? []).map(formatConversation),
		[conversations],
	)
	const userItems = useMemo(() => (users ?? []).map(formatUser), [users])

	// Fast-lookup for `is_member` when rendering chips / per-row trailing hints.
	const conversationById = useMemo(
		() => new Map<string, SlackConversation>((conversations ?? []).map((c) => [c.id, c])),
		[conversations],
	)

	const isReaction = entityType === 'slack.reaction'
	const setupUxV2 = useFeatureFlag(SLACK_SETUP_UX_V2_FLAG)

	// PostHog surfaces picker adoption + non-member-picking behaviour so the
	// bet's dogfood telemetry can distinguish "users pick channels the bot
	// isn't in yet" (the whole reason PR B ships auto-join) from a
	// members-only picker.
	function captureChannelPickerUsage(nextInclude: string[], nextExclude: string[]): void {
		if (!setupUxV2) return
		const selectedIds = [...nextInclude, ...nextExclude]
		const hasNonMember = selectedIds.some((id) => {
			const c = conversationById.get(id)
			return c ? c.is_member === false : false
		})
		capture('slack.channel_picker.used', {
			workspace_id: workspaceId,
			entity_type: entityType,
			channels_selected_count: selectedIds.length,
			has_non_member_channel: hasNonMember,
		})
	}

	function handleIncludeChange(next: string[]): void {
		onChange({ ...value, channelsInclude: next })
		captureChannelPickerUsage(next, value.channelsExclude)
	}

	function handleExcludeChange(next: string[]): void {
		onChange({ ...value, channelsExclude: next })
		captureChannelPickerUsage(value.channelsInclude, next)
	}

	const showFooter = setupUxV2 && conversationItems.length === CHANNEL_TRUNCATION_LIMIT
	const truncationFooter = showFooter ? TRUNCATION_FOOTER_V2 : undefined

	const channelEmptyText = setupUxV2
		? EMPTY_CHANNELS_COPY_V2
		: 'No channels found. Make sure the bot is invited.'

	// Per-chip render: a small warning dot when the bot isn't a member.
	function renderChipMembership(item: MultiSelectItem): React.ReactNode {
		if (!setupUxV2) return null
		const conv = conversationById.get(item.id)
		if (!conv || conv.is_member !== false) return null
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<span
							role="img"
							aria-label="Bot not a member of this channel"
							className="inline-flex items-center text-warning"
						>
							<AlertCircle size={12} />
						</span>
					</TooltipTrigger>
					<TooltipContent>{NON_MEMBER_TOOLTIP}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		)
	}

	// Per-row render: an inline "not a member" hint on non-member channels in the popover.
	function renderRowMembership(item: MultiSelectItem): React.ReactNode {
		if (!setupUxV2) return null
		const conv = conversationById.get(item.id)
		if (!conv || conv.is_member !== false) return null
		return <span className="shrink-0 text-xs text-warning">not a member</span>
	}

	if (!integrationId) {
		return (
			<div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
				Connect Slack to add channel and user filters.
			</div>
		)
	}

	return (
		<div className="space-y-4">
			{setupUxV2 && convError && (
				<div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
					{ERROR_COPY_V2}{' '}
					<a
						href={`/${workspaceId}/settings/integrations`}
						className="underline underline-offset-2"
					>
						Open Integrations
					</a>
				</div>
			)}
			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Only fire if in these channels (optional)
				</p>
				<SearchableMultiSelect
					items={conversationItems}
					selectedIds={value.channelsInclude}
					onChange={handleIncludeChange}
					placeholder="Search channels…"
					emptyText={channelEmptyText}
					loading={convLoading}
					trailing={renderRowMembership}
					renderSelected={renderChipMembership}
					footer={truncationFooter}
				/>
			</div>

			<div className="space-y-2">
				<p className="text-xs font-medium text-muted-foreground">
					Never fire if in these channels (optional)
				</p>
				<SearchableMultiSelect
					items={conversationItems}
					selectedIds={value.channelsExclude}
					onChange={handleExcludeChange}
					placeholder="Search channels…"
					emptyText={setupUxV2 ? EMPTY_CHANNELS_COPY_V2 : 'No channels found.'}
					loading={convLoading}
					trailing={renderRowMembership}
					renderSelected={renderChipMembership}
					footer={truncationFooter}
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
