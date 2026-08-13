import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogClose,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { Separator } from '@/components/ui/separator'
import type { ActorListItem, NotificationResponse } from '@/lib/api'
import { Check, Clock, X } from 'lucide-react'
import { useState } from 'react'

export type AskResponse = 'approve' | 'hold'

interface AskPanelProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	subtitle?: string
	/** needs_input notifications scoped to the current selection (any status). */
	asks: NotificationResponse[]
	actorsById: Map<string, ActorListItem>
	onRespond: (id: string, response: AskResponse) => void
}

function doneLabel(notification: NotificationResponse, override?: AskResponse): string {
	const response = override ?? notification.metadata?.response
	if (response === 'approve') return 'Approved'
	if (response === 'hold') return 'Held'
	if (notification.status === 'dismissed') return 'Dismissed'
	return 'Resolved'
}

function DonePill({
	notification,
	override,
}: { notification: NotificationResponse; override?: AskResponse }) {
	const label = doneLabel(notification, override)
	const tone =
		label === 'Approved'
			? 'border-transparent bg-success/15 text-success'
			: label === 'Held'
				? 'border-transparent bg-warning/10 text-warning'
				: 'border-transparent bg-muted text-muted-foreground'
	const Icon = label === 'Approved' ? Check : label === 'Held' ? Clock : undefined
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone}`}
		>
			{Icon && <Icon className="size-3" />}
			{label}
		</span>
	)
}

export function AskPanel({
	open,
	onOpenChange,
	title,
	subtitle,
	asks,
	actorsById,
	onRespond,
}: AskPanelProps) {
	// Optimistically record which way a human answered so the done label is
	// correct the instant a button is pressed, before the refetch lands.
	const [localResponse, setLocalResponse] = useState<Record<string, AskResponse>>({})

	const isDone = (a: NotificationResponse) => localResponse[a.id] != null || a.status !== 'pending'
	const pendingAsks = asks.filter((a) => !isDone(a))
	const resolvedAsks = asks.filter(isDone)
	const pendingCount = pendingAsks.length

	const handleRespond = (a: NotificationResponse, response: AskResponse) => {
		setLocalResponse((prev) => ({ ...prev, [a.id]: response }))
		onRespond(a.id, response)
	}

	const handleApproveAll = () => {
		for (const a of pendingAsks) handleRespond(a, 'approve')
	}

	const askText = (a: NotificationResponse) => a.content ?? a.title
	const actorName = (a: NotificationResponse) => actorsById.get(a.sourceActorId)?.name ?? 'Agent'

	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent className="sm:max-w-lg">
				<ResponsiveDialogHeader className="flex flex-row items-start justify-between gap-4">
					<div className="space-y-1">
						<ResponsiveDialogTitle className="text-base">{title}</ResponsiveDialogTitle>
						{subtitle && (
							<ResponsiveDialogDescription className="text-xs text-muted-foreground">
								{subtitle}
							</ResponsiveDialogDescription>
						)}
					</div>
					<ResponsiveDialogClose asChild>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
							aria-label="Close"
						>
							<X className="size-4" />
						</Button>
					</ResponsiveDialogClose>
				</ResponsiveDialogHeader>

				<Separator />

				{asks.length === 0 ? (
					<EmptyState
						title="Nothing waiting here"
						description="Agents will surface an ask here when they need your input."
					/>
				) : (
					<ul className="min-h-0 divide-y divide-border">
						{pendingAsks.map((a) => (
							<li key={a.id} className="flex items-start gap-3 py-3">
								<ActorAvatar
									name={actorName(a)}
									type="agent"
									id={a.sourceActorId}
									size="sm"
									className="mt-0.5"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium leading-tight">{actorName(a)}</p>
									<p className="mt-0.5 text-sm leading-snug text-muted-foreground">{askText(a)}</p>
								</div>
								<div className="flex shrink-0 items-center gap-1.5">
									<Button type="button" size="sm" onClick={() => handleRespond(a, 'approve')}>
										<Check className="mr-1 size-3" />
										Approve
									</Button>
									<Button
										type="button"
										size="sm"
										variant="outline"
										onClick={() => handleRespond(a, 'hold')}
									>
										<Clock className="mr-1 size-3" />
										Hold
									</Button>
								</div>
							</li>
						))}
						{resolvedAsks.map((a) => (
							<li key={a.id} className="flex items-start gap-3 py-3">
								<ActorAvatar
									name={actorName(a)}
									type="agent"
									id={a.sourceActorId}
									size="sm"
									className="mt-0.5"
								/>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium leading-tight">{actorName(a)}</p>
									<p className="mt-0.5 text-sm leading-snug text-muted-foreground">{askText(a)}</p>
								</div>
								<DonePill notification={a} override={localResponse[a.id]} />
							</li>
						))}
					</ul>
				)}

				<ResponsiveDialogFooter className="flex flex-wrap items-center justify-between gap-3 border-t pt-3">
					{pendingCount > 1 ? (
						<Button type="button" size="sm" variant="outline" onClick={handleApproveAll}>
							Approve all {pendingCount}
						</Button>
					) : (
						<span aria-hidden="true" />
					)}
					<span className="text-xs text-muted-foreground">
						{pendingCount > 0
							? 'Each agent replies in its own thread'
							: 'Nothing left waiting here'}
					</span>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
