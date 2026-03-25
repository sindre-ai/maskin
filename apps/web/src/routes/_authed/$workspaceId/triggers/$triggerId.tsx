import { PageHeader } from '@/components/layout/page-header'
import { Skeleton } from '@/components/shared/loading-skeleton'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import { useDeleteTrigger, useTrigger, useUpdateTrigger } from '@/hooks/use-triggers'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/triggers/$triggerId')({
	component: TriggerDetailPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function TriggerDetailPage() {
	const { triggerId } = Route.useParams()
	const { workspaceId } = useWorkspace()
	const { data: trigger, isLoading, error } = useTrigger(triggerId, workspaceId)
	const { data: actors } = useActors(workspaceId)
	const updateTrigger = useUpdateTrigger(workspaceId)
	const deleteTrigger = useDeleteTrigger(workspaceId)
	const navigate = useNavigate()

	const agents = (actors ?? []).filter((a) => a.type === 'agent')

	if (isLoading) {
		return (
			<div className="max-w-3xl mx-auto space-y-4">
				<Skeleton className="h-8 w-64" />
				<Skeleton className="h-4 w-96" />
				<Skeleton className="h-32 w-full" />
			</div>
		)
	}

	if (error || !trigger) {
		return (
			<div className="flex items-center justify-center py-16">
				<p className="text-sm text-muted-foreground">{error?.message || "Trigger not found"}</p>
			</div>
		)
	}

	const handleUpdate = (data: Record<string, unknown>) => {
		updateTrigger.mutate({ id: trigger.id, data })
	}

	const handleDelete = () => {
		deleteTrigger.mutate(trigger.id, {
			onSuccess: () => {
				navigate({
					to: '/$workspaceId/triggers',
					params: { workspaceId },
					search: { create: false },
				})
			},
		})
	}

	const config = trigger.config as Record<string, unknown> | null

	return (
		<>
			<PageHeader />
			<div className="max-w-3xl mx-auto">
				<EditableName
					value={trigger.name}
					onSave={(name) => handleUpdate({ name })}
				/>

				<div className="flex flex-wrap items-center gap-2 mb-6">
					<span
						className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${
							trigger.enabled
								? 'bg-success/10 text-success'
								: 'bg-muted text-muted-foreground'
						}`}
					>
						<span
							className={`h-1.5 w-1.5 rounded-full ${trigger.enabled ? `bg-success` : `bg-zinc-600`}`}
						/>
						{trigger.enabled ? 'Enabled' : 'Disabled'}
					</span>
					<span className="text-xs text-muted-foreground">{trigger.type}</span>
				</div>

				{/* Enabled toggle */}
				<Section title="Status">
					<Button
						variant='outline'
						size='sm'
						onClick={() => handleUpdate({ enabled: !trigger.enabled })}
					>
						{trigger.enabled ? 'Disable trigger' : 'Enable trigger'}
					</Button>
				</Section>

				{/* Action Prompt */}
				<Section title="Action Prompt">
					<EditableTextarea
						value={trigger.actionPrompt ?? ''}
						onSave={(action_prompt) => handleUpdate({ action_prompt })}
					/>
				</Section>

				{/* Target Agent */}
				<Section title="Target Agent">
					<Select
						value={trigger.targetActorId}
						onValueChange={(target_actor_id) => handleUpdate({ target_actor_id })}
					>
						<SelectTrigger className="w-64">
							<SelectValue placeholder="Select agent..." />
						</SelectTrigger>
						<SelectContent>
							{agents.map((a) => (
								<SelectItem key={a.id} value={a.id}>
									{a.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Section>

				{/* Config (read-only display) */}
				{config && (
					<Section title="Configuration">
						<div className="rounded border border-border bg-background p-3 text-xs font-mono text-muted-foreground">
							{trigger.type === 'cron' && config.expression != null && (
								<p>Cron: {String(config.expression)}</p>
							)}
							{trigger.type === 'reminder' && config.scheduled_at != null && (
								<p>Scheduled: {new Date(String(config.scheduled_at)).toLocaleString()}</p>
							)}
							{trigger.type === 'event' && (
								<>
									{config.entity_type != null && <p>Entity: {String(config.entity_type)}</p>}
									{config.action != null && <p>Action: {String(config.action)}</p>}
									{config.from_status != null && <p>From: {String(config.from_status)}</p>}
									{config.to_status != null && <p>To: {String(config.to_status)}</p>}
								</>
							)}
						</div>
					</Section>
				)}

				{/* Delete */}
				<div className="border-t border-border pt-6">
					<Button
						variant='ghost'
						size='sm'
						className="text-error hover:text-error"
						onClick={handleDelete}
						disabled={deleteTrigger.isPending}
					>
						{deleteTrigger.isPending ? 'Deleting...' : 'Delete trigger'}
					</Button>
				</div>
			</div>
		</>
	)
}

function EditableName({ value, onSave }: { value: string; onSave: (v: string) => void }) {
	const [editing, setEditing] = useState(false)
	const [draft, setDraft] = useState(value)
	const inputRef = useRef<HTMLInputElement>(null)

	useEffect(() => {
		if (editing) inputRef.current?.focus()
	}, [editing])

	const handleBlur = useCallback(() => {
		setEditing(false)
		if (draft.trim() && draft !== value) {
			onSave(draft.trim())
		}
	}, [draft, value, onSave])

	if (editing) {
		return (
			<input
				ref={inputRef}
				type='text'
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={handleBlur}
				onKeyDown={(e) => e.key === 'Enter' && handleBlur()}
				className="w-full text-2xl font-semibold tracking-tight bg-transparent border-none outline-none text-foreground mb-2 h-auto p-0 focus:outline-none"
			/>
		)
	}

	return (
		<button
			type="button"
			className="w-full text-left text-2xl font-semibold tracking-tight text-foreground mb-2 cursor-text bg-transparent border-none outline-none p-0"
			onClick={() => {
				setDraft(value)
				setEditing(true)
			}}
		>
			{value}
		</button>
	)
}

function EditableTextarea({ value, onSave }: { value: string; onSave: (v: string) => void }) {
	const [draft, setDraft] = useState(value)
	const [dirty, setDirty] = useState(false)

	const handleBlur = useCallback(() => {
		if (dirty && draft !== value) {
			onSave(draft)
		}
		setDirty(false)
	}, [draft, dirty, value, onSave])

	return (
		<Textarea
			value={draft}
			onChange={(e) => {
				setDraft(e.target.value)
				setDirty(true)
			}}
			onBlur={handleBlur}
			placeholder="Action prompt for the agent..."
			className="min-h-[100px] font-mono text-sm"
		/>
	)
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
	return (
		<div className="mb-6">
			<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
				{title}
			</h3>
			{children}
		</div>
	)
}
