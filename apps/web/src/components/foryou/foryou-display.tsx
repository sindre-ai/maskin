import { AgentCallButton } from '@/components/agents/agent-call-button'
import { LiveCapsule } from '@/components/agents/live-call-surface'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { typeLabel } from '@/lib/constants'
import { FEED_KIND_LABEL, type FeedKind } from '@/lib/foryou-feed'
import { useVoiceCallView } from '@/lib/voice-call-view'
import { LayoutList, Rows3 } from 'lucide-react'
import { useMemo } from 'react'

export type FeedMode = 'cards' | 'list'

export interface ForYouTypeOption {
	value: string | undefined
	label: string
	count: number
}

/**
 * "Everything" plus one row per kind of card that has unread cards: Decisions, Drafts,
 * Updates, in that order (the prototype's filters). A key that is not a card kind falls
 * back to the item-type name.
 */
export function forYouTypeOptions(
	unreadCount: number,
	typeCounts: Map<string, number>,
): ForYouTypeOption[] {
	const kinds = Object.keys(FEED_KIND_LABEL)
	const rank = (key: string) => (kinds.includes(key) ? kinds.indexOf(key) : kinds.length)
	return [
		{ value: undefined, label: 'Everything', count: unreadCount },
		...Array.from(typeCounts.entries())
			.filter(([, count]) => count > 0)
			.sort(([a], [b]) => rank(a) - rank(b))
			.map(([key, count]) => ({
				value: key,
				label: FEED_KIND_LABEL[key as FeedKind] ?? `${typeLabel(key)}s`,
				count,
			})),
	]
}

interface ForYouDisplayProps {
	mode: FeedMode
	onModeChange: (mode: FeedMode) => void
	typeFilter: string | undefined
	onTypeFilterChange: (value: string | undefined) => void
	unreadCount: number
	typeCounts: Map<string, number>
	filterPills: boolean
	onFilterPillsChange: (value: boolean) => void
}

/**
 * For you's Display menu: the shared DisplayPanel with a Cards | List View rail
 * and a "Show" block (what the feed lists). There is no sort (the Chief of
 * Staff sets the order) and no grouping.
 */
export function ForYouDisplay({
	mode,
	onModeChange,
	typeFilter,
	onTypeFilterChange,
	unreadCount,
	typeCounts,
	filterPills,
	onFilterPillsChange,
}: ForYouDisplayProps) {
	const typeOptions = useMemo(
		() => forYouTypeOptions(unreadCount, typeCounts),
		[unreadCount, typeCounts],
	)
	const activeLabel = typeOptions.find((option) => option.value === typeFilter)?.label

	return (
		<DisplayPanel
			viewChoices={[
				{ id: 'cards', label: 'Cards', icon: <LayoutList size={15} aria-hidden="true" /> },
				{ id: 'list', label: 'List', icon: <Rows3 size={15} aria-hidden="true" /> },
			]}
			viewChoice={mode}
			onViewChoiceChange={(id) => onModeChange(id === 'list' ? 'list' : 'cards')}
			filtersLabel="Show"
			resetFiltersLabel="Reset filters"
			resetLabel="Reset display"
			activeFilterCount={typeFilter ? 1 : 0}
			filterSections={[
				{
					id: 'type',
					label: 'Kind',
					summary: activeLabel ?? 'Everything',
					pinnable: false,
					defaultExpanded: true,
					options: typeOptions.map((option) => ({
						id: option.value ?? 'all',
						label: option.label,
						count: option.count,
						active: typeFilter === option.value,
						onToggle: () =>
							onTypeFilterChange(typeFilter === option.value ? undefined : option.value),
					})),
				},
				{
					id: 'bar',
					label: 'Filter bar',
					summary: filterPills ? 'On' : 'Off',
					pinnable: false,
					options: [
						{
							id: 'under-header',
							label: 'Show under the header',
							active: filterPills,
							onToggle: () => onFilterPillsChange(!filterPills),
						},
					],
				},
			]}
			onResetFilters={() => onTypeFilterChange(undefined)}
			onResetToDefault={() => {
				onModeChange('cards')
				onTypeFilterChange(undefined)
				onFilterPillsChange(false)
			}}
		/>
	)
}

/**
 * Live in the For you title row: a call with the workspace's default agent
 * (the Chief of Staff). Hidden until that agent resolves; while a call is on
 * it is the same capsule every other page shows.
 */
export function ForYouLive() {
	const agent = useDefaultChatAgent()
	const liveCall = useVoiceCallView()
	if (liveCall) return <LiveCapsule />
	if (!agent) return null
	return (
		<AgentCallButton
			agent={{ id: agent.id, name: agent.name, type: 'agent' }}
			variant="detail"
			label="Live"
			shortcut={false}
		/>
	)
}
