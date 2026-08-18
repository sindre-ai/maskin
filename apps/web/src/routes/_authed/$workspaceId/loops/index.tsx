import { PageHeader } from '@/components/layout/page-header'
import { AssignedInChatRow } from '@/components/loops/assigned-in-chat-row'
import { LoopRow } from '@/components/loops/loop-row'
import { DisplayPanel } from '@/components/objects/data-table/display-panel'
import { CreatePicker, isCreateShortcut } from '@/components/shared/create-picker'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { TriggerRow } from '@/components/triggers/trigger-row'
import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useConversationsInfinite } from '@/hooks/use-conversations'
import { useLoops } from '@/hooks/use-loops'
import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { useUpdateTrigger } from '@/hooks/use-triggers'
import {
	useUpdateUserDisplaySettings,
	useUserDisplaySettings,
} from '@/hooks/use-user-display-settings'
import { getActiveAgentSessions } from '@/lib/agent-status'
import type {
	ConversationListItemResponse,
	ConversationParticipantResponse,
	DisplaySettingsBody,
	LoopSummary,
} from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'

// Display settings are keyed by object type; `loop` is a real object type, so
// the loops list persists its ordering in the same store Objects uses.
const LOOP_SETTINGS_KEY = 'loop'
const DEFAULT_SORT = 'updatedAt'
const DEFAULT_ORDER: 'asc' | 'desc' = 'desc'

const LOOP_ORDER_COLUMNS = [
	{ id: 'updatedAt', label: 'Last activity', canHide: false },
	{ id: 'name', label: 'Name', canHide: false },
	{ id: 'inProgressCount', label: 'In progress', canHide: false },
]

function compareLoops(a: LoopSummary, b: LoopSummary, sort: string): number {
	if (sort === 'name') return (a.name ?? '').localeCompare(b.name ?? '')
	if (sort === 'inProgressCount') return a.inProgressCount - b.inProgressCount
	return new Date(a.updatedAt ?? 0).getTime() - new Date(b.updatedAt ?? 0).getTime()
}

export const Route = createFileRoute('/_authed/$workspaceId/loops/')({
	component: LoopsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function LoopsPage() {
	const { workspaceId } = useWorkspace()
	const { data: loops, isLoading: loopsLoading } = useLoops(workspaceId)
	const { data: triggers } = useTriggers(workspaceId)
	const { data: actors } = useActors(workspaceId)
	const { data: sessions } = useWorkspaceSessions(workspaceId)
	const { data: conversationPages } = useConversationsInfinite(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const [createPickerOpen, setCreatePickerOpen] = useState(false)

	const settingsQuery = useUserDisplaySettings(workspaceId, LOOP_SETTINGS_KEY)
	const upsertSettings = useUpdateUserDisplaySettings(workspaceId)
	const persistedSettings = settingsQuery.data?.settings
	const sort = persistedSettings?.sort ?? DEFAULT_SORT
	const order = persistedSettings?.order ?? DEFAULT_ORDER

	const writeSettings = useCallback(
		(patch: DisplaySettingsBody | null) => {
			upsertSettings.mutate({
				objectType: LOOP_SETTINGS_KEY,
				settings: patch === null ? {} : { ...(persistedSettings ?? {}), ...patch },
			})
		},
		[upsertSettings, persistedSettings],
	)

	useEffect(() => {
		function onKeydown(event: KeyboardEvent) {
			if (!isCreateShortcut(event)) return
			event.preventDefault()
			setCreatePickerOpen(true)
		}
		window.addEventListener('keydown', onKeydown)
		return () => window.removeEventListener('keydown', onKeydown)
	}, [])

	const sortedLoops = useMemo(() => {
		const list = [...(loops ?? [])]
		list.sort((a, b) => (order === 'asc' ? 1 : -1) * compareLoops(a, b, sort))
		return list
	}, [loops, sort, order])

	// `LoopSummary.triggerIds` is the canonical membership field — a trigger is
	// standalone iff no loop names it. (The previous target-actor heuristic hid
	// any standalone trigger that happened to share an agent with a loop.)
	const standaloneTriggers = useMemo(() => {
		if (!triggers) return []
		const tied = new Set((loops ?? []).flatMap((l) => l.triggerIds))
		return triggers.filter((t) => !tied.has(t.id))
	}, [loops, triggers])

	// Agents with a live session right now — colours the loop rows' busy line
	// and the "Assigned in chat" state dot.
	const workingAgentIds = useMemo(
		() => new Set(getActiveAgentSessions(sessions ?? []).map((s) => s.actorId)),
		[sessions],
	)

	// Work handed an agent directly in a chat thread — outside any cycle. The
	// first page is enough; these rows are a recent-activity glance, not a log.
	const assignedInChat = useMemo(() => {
		const conversations = conversationPages?.pages?.[0]?.conversations ?? []
		const rows: {
			conversation: ConversationListItemResponse
			agent: ConversationParticipantResponse
		}[] = []
		for (const conversation of conversations) {
			if (conversation.archived) continue
			const agent = conversation.participants.find((p) => p.actorType === 'agent')
			if (!agent) continue
			rows.push({ conversation, agent })
			if (rows.length === 5) break
		}
		return rows
	}, [conversationPages])

	const hasLoops = sortedLoops.length > 0

	return (
		<div>
			<PageHeader
				title="Loops"
				subtitle={String(loops?.length ?? 0)}
				actions={
					<DisplayPanel
						showView={false}
						columns={LOOP_ORDER_COLUMNS}
						sort={sort}
						order={order}
						onSortChange={(value) => writeSettings({ sort: value })}
						onOrderChange={(value) => writeSettings({ order: value })}
						onResetToDefault={() => writeSettings(null)}
					/>
				}
			/>
			{loopsLoading ? (
				<ListSkeleton />
			) : (
				<div className="space-y-10">
					<section className="flex flex-col">
						{hasLoops ? (
							sortedLoops.map((loop) => (
								<LoopRow
									key={loop.id}
									loop={loop}
									actors={actors}
									busyAgentCount={loop.agentIds.filter((id) => workingAgentIds.has(id)).length}
								/>
							))
						) : (
							<EmptyState
								icon={<RefreshCw size={22} aria-hidden="true" />}
								title="No loops running here yet"
								description="Loops are persistent, multi-agent processes — a named pipeline that continuously ingests work, routes it through several agents, and surfaces decisions to you. Install one from the Marketplace, or start a new one."
								action={
									<div className="flex items-center gap-2">
										<Button size="sm" asChild>
											<Link to="/$workspaceId/loops/new" params={{ workspaceId }}>
												Start a loop
											</Link>
										</Button>
										<Button size="sm" variant="outline" asChild>
											<Link to="/$workspaceId/marketplace" params={{ workspaceId }}>
												Browse the Marketplace
											</Link>
										</Button>
									</div>
								}
							/>
						)}
					</section>

					{standaloneTriggers.length > 0 && (
						<section>
							<header className="flex items-center gap-2.5 px-1">
								<h2 className="text-sm font-bold text-foreground">Not tied to a loop</h2>
								<p className="text-[11px] text-muted-foreground">
									workspace-wide automations that run on their own
								</p>
								<span aria-hidden="true" className="h-px flex-1 bg-border" />
							</header>
							<div className="flex flex-col gap-2 pt-3">
								{standaloneTriggers.map((trigger) => {
									const agent = actors?.find((a) => a.id === trigger.targetActorId)
									return (
										<TriggerRow
											key={trigger.id}
											trigger={trigger}
											workspaceId={workspaceId}
											agentId={agent?.id}
											agentType={agent?.type}
											agentName={agent?.name ?? 'Unknown'}
											isToggling={updateTrigger.isPending}
											onToggleEnabled={(next) =>
												updateTrigger.mutate({ id: trigger.id, data: { enabled: next } })
											}
										/>
									)
								})}
							</div>
						</section>
					)}

					{assignedInChat.length > 0 && (
						<section>
							<header className="flex items-center gap-2.5 px-1">
								<h2 className="text-sm font-bold text-foreground">Assigned in chat</h2>
								<p className="text-[11px] text-muted-foreground">
									work you handed an agent yourself — outside any cycle
								</p>
								<span aria-hidden="true" className="h-px flex-1 bg-border" />
							</header>
							<div className="flex flex-col gap-2 pt-3">
								{assignedInChat.map(({ conversation, agent }) => (
									<AssignedInChatRow
										key={conversation.id}
										conversation={conversation}
										workspaceId={workspaceId}
										agentId={agent.actorId}
										agentType={agent.actorType}
										agentName={agent.actorName}
										isWorking={workingAgentIds.has(agent.actorId)}
									/>
								))}
							</div>
						</section>
					)}
				</div>
			)}
			<CreatePicker open={createPickerOpen} onOpenChange={setCreatePickerOpen} defaultType="loop" />
		</div>
	)
}
