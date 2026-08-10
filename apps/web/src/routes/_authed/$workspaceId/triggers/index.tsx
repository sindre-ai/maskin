import { PageHeader } from '@/components/layout/page-header'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Input } from '@/components/ui/input'
import { useActors } from '@/hooks/use-actors'
import { useTriggers } from '@/hooks/use-triggers'
import type { TriggerResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/')({
	component: TriggersPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggersPage() {
	const { workspaceId } = useWorkspace()
	const { data: triggers, isLoading } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)
	const [query, setQuery] = useState('')

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const trimmedQuery = query.trim()

	const filteredTriggers = useMemo(() => {
		if (!triggers) return triggers
		return triggers.filter((trigger) => {
			const agent = actors?.find((a) => a.id === trigger.targetActorId)
			return matchesTriggerQuery(trigger, agent?.name, trimmedQuery)
		})
	}, [triggers, actors, trimmedQuery])

	return (
		<div>
			<PageHeader title="Triggers" />

			{isLoading ? (
				<ListSkeleton />
			) : !triggers?.length ? (
				<EmptyState
					title="No triggers yet"
					description="Triggers automate your workspace by running agents in response to events, schedules, or one-time reminders. Create your first trigger to get started."
				/>
			) : (
				<div className="space-y-1">
					<p className="text-xs text-muted-foreground mb-3">
						Triggers automatically run agents when events happen, on a schedule, or at a specific
						time.
					</p>
					<Input
						type="search"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search triggers…"
						aria-label="Filter triggers"
						className="mb-3 w-full shrink-0 md:w-80"
					/>
					{filteredTriggers?.length === 0 ? (
						<EmptyState title="No matches" description="Try a different search term." />
					) : (
						<div className="space-y-2">
							{filteredTriggers?.map((trigger) => {
								const agent = actors?.find((a) => a.id === trigger.targetActorId)
								return (
									<TriggerRow
										key={trigger.id}
										trigger={trigger}
										workspaceId={workspaceId}
										agentName={agent?.name ?? 'Unknown'}
									/>
								)
							})}
						</div>
					)}
				</div>
			)}
			<CreatePicker
				open={createPickerOpen}
				onOpenChange={setCreatePickerOpen}
				defaultType="trigger"
			/>
		</div>
	)
}

function matchesTriggerQuery(
	trigger: TriggerResponse,
	agentName: string | undefined,
	query: string,
): boolean {
	if (!query) return true
	const needle = query.toLowerCase()
	return (
		trigger.name.toLowerCase().includes(needle) ||
		trigger.actionPrompt.toLowerCase().includes(needle) ||
		(agentName?.toLowerCase().includes(needle) ?? false)
	)
}
