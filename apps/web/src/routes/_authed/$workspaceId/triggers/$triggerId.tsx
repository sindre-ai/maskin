import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { QueryStateError } from '@/components/shared/query-state'
import { RouteError } from '@/components/shared/route-error'
import { TriggerForm } from '@/components/triggers/trigger-form'
import type { TriggerFormPayload } from '@/components/triggers/trigger-form'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActors } from '@/hooks/use-actors'
import {
	useCreateTrigger,
	useDeleteTrigger,
	useTrigger,
	useUpdateTrigger,
} from '@/hooks/use-triggers'
import { trackTriggerUpdated } from '@/lib/analytics'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Check, MoreHorizontal, Pause, Play, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/$triggerId')({
	component: TriggerDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggerDetailPage() {
	const { triggerId } = Route.useParams()
	const { workspaceId, workspace } = useWorkspace()
	const { data: trigger, isLoading, isError, error, refetch } = useTrigger(triggerId, workspaceId)
	const { data: actors } = useActors(workspaceId)
	const createTrigger = useCreateTrigger(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const deleteTrigger = useDeleteTrigger(workspaceId)
	const navigate = useNavigate()
	const isCreatedRef = useRef(false)
	// Autosave state is lifted out of the form so `✓ Saved` can sit in the shared
	// top-nav row beside `⋯` and delete (mockup 1586).
	const [showSaved, setShowSaved] = useState(false)
	const handleSavedChange = useCallback((saved: boolean) => setShowSaved(saved), [])

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	// Once the trigger exists in cache, mark as created
	useEffect(() => {
		if (trigger) isCreatedRef.current = true
	}, [trigger])
	const isCreated = isCreatedRef.current || !!trigger

	if (isLoading && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-full max-w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	// The triggers list fetch failing shouldn't silently drop the user into
	// create mode — that's a real load failure and needs a retry surface.
	if (isError && !isCreated) {
		return (
			<div className="max-w-3xl mx-auto">
				<QueryStateError
					title="Couldn't load this trigger"
					error={error ?? new Error('Something went wrong.')}
					onRetry={() => refetch()}
				/>
			</div>
		)
	}

	const handleAutoCreate = async (payload: TriggerFormPayload) => {
		if (isCreatedRef.current) return
		isCreatedRef.current = true
		try {
			await createTrigger.mutateAsync({
				id: triggerId,
				name: payload.name,
				type: payload.type,
				action_prompt: payload.action_prompt,
				target_actor_id: payload.target_actor_id,
				config: payload.config as never,
				enabled: payload.enabled,
			})
			toast.success('Trigger created')
		} catch {
			isCreatedRef.current = false
		}
	}

	const handleSave = (payload: TriggerFormPayload) => {
		updateTrigger.mutate(
			{
				id: triggerId,
				data: {
					name: payload.name,
					type: payload.type,
					action_prompt: payload.action_prompt,
					target_actor_id: payload.target_actor_id,
					config: payload.config as never,
				},
			},
			{
				onSuccess: () => trackTriggerUpdated({ entity_id: triggerId, entity_type: 'trigger' }),
			},
		)
	}

	const handleDelete = () => {
		deleteTrigger.mutate(triggerId, {
			onSuccess: () => {
				// `/triggers` now redirects to `/loops`; go straight there so the
				// post-delete navigation doesn't bounce through a redirect.
				navigate({
					to: '/$workspaceId/loops',
					params: { workspaceId },
				})
			},
		})
	}

	const handleToggleEnabled = () => {
		if (!trigger) return
		updateTrigger.mutate(
			{ id: triggerId, data: { enabled: !trigger.enabled } },
			{
				onSuccess: () => trackTriggerUpdated({ entity_id: triggerId, entity_type: 'trigger' }),
			},
		)
	}

	return (
		<>
			<PageHeader
				actions={
					isCreated ? (
						<>
							<span
								aria-live="polite"
								className={`inline-flex items-center gap-1.5 text-[11px] text-muted-foreground transition-opacity duration-200 motion-reduce:transition-none ${
									showSaved ? 'opacity-100' : 'opacity-0'
								}`}
							>
								<Check size={13} />
								Saved
							</span>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="ghost"
										size="icon"
										className="h-7 w-7 text-muted-foreground"
										aria-label="More"
									>
										<MoreHorizontal size={15} />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onSelect={handleToggleEnabled}>
										{trigger?.enabled ? (
											<>
												<Pause size={14} /> Pause trigger
											</>
										) : (
											<>
												<Play size={14} /> Resume trigger
											</>
										)}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
							<Button
								variant="ghost"
								size="icon"
								className="h-7 w-7 text-muted-foreground hover:text-error"
								onClick={handleDelete}
								aria-label="Delete trigger"
							>
								<Trash2 size={15} />
							</Button>
						</>
					) : undefined
				}
			/>
			<TriggerForm
				workspaceId={workspaceId}
				workspace={workspace}
				agents={agents}
				initialValues={trigger}
				onAutoCreate={!isCreated ? handleAutoCreate : undefined}
				onSave={isCreated ? handleSave : undefined}
				onToggleEnabled={isCreated ? handleToggleEnabled : undefined}
				onSavedChange={handleSavedChange}
				isPending={createTrigger.isPending || updateTrigger.isPending}
				error={createTrigger.error || updateTrigger.error}
				isCreated={isCreated}
			/>
		</>
	)
}
