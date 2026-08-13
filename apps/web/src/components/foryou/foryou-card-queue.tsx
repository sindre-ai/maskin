import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { useBulkRespondNotifications, useRespondNotification } from '@/hooks/use-notifications'
import type { NotificationResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
	FORYOU_BUCKET_ORDER,
	type ForYouBucket,
	type ForYouGroup,
	bulkResponseFor,
	groupNotifications,
} from '@/lib/foryou-buckets'
import { Link } from '@tanstack/react-router'
import { CheckIcon, ChevronDown } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

interface ForYouCardQueueProps {
	workspaceId: string
	notifications: NotificationResponse[]
}

export function ForYouCardQueue({ workspaceId, notifications }: ForYouCardQueueProps) {
	const grouped = useMemo(() => groupNotifications(notifications), [notifications])

	const totalGroups =
		grouped.decision.length + grouped.waiting.length + grouped.fyi.length + grouped.handled.length

	if (totalGroups === 0) {
		return (
			<div className="flex flex-1 min-h-0 flex-col gap-4 pb-24" data-testid="foryou-card-queue">
				<EmptyState
					title="You're caught up"
					description="Nothing needs you right now. The loops keep running — you'll hear when one does."
					action={
						<div className="flex flex-wrap items-center justify-center gap-3">
							<Button size="sm" variant="outline" asChild>
								<Link to="/$workspaceId/briefing" params={{ workspaceId }}>
									Today's brief
								</Link>
							</Button>
							<Button size="sm" variant="ghost" asChild>
								<Link to="/$workspaceId/loops" params={{ workspaceId }}>
									Review loops →
								</Link>
							</Button>
						</div>
					}
				/>
			</div>
		)
	}

	return (
		<div className="flex flex-1 min-h-0 flex-col gap-6 pb-24" data-testid="foryou-card-queue">
			{FORYOU_BUCKET_ORDER.map((bucket) => {
				const groups = grouped[bucket.key]
				if (groups.length === 0) return null
				return (
					<Bucket
						key={bucket.key}
						workspaceId={workspaceId}
						bucketKey={bucket.key}
						label={bucket.label}
						groups={groups}
					/>
				)
			})}
		</div>
	)
}

interface BucketProps {
	workspaceId: string
	bucketKey: ForYouBucket
	label: string
	groups: ForYouGroup[]
}

function Bucket({ workspaceId, bucketKey, label, groups }: BucketProps) {
	return (
		<section
			className="mx-auto w-full max-w-[760px]"
			data-testid="foryou-bucket"
			data-bucket={bucketKey}
		>
			<header className="mb-2 flex items-baseline justify-between">
				<h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
					{label}
				</h2>
				<span className="text-xs text-muted-foreground">
					{groups.length} {groups.length === 1 ? 'item' : 'items'}
				</span>
			</header>
			<div className="flex flex-col gap-3">
				{groups.map((group) => (
					<GroupCard key={group.key} workspaceId={workspaceId} group={group} />
				))}
			</div>
		</section>
	)
}

interface GroupCardProps {
	workspaceId: string
	group: ForYouGroup
}

function GroupCard({ workspaceId, group }: GroupCardProps) {
	const [expanded, setExpanded] = useState(false)
	const bulkRespond = useBulkRespondNotifications(workspaceId)
	const singleRespond = useRespondNotification(workspaceId)

	const isGrouped = group.items.length > 1
	const primary = group.primary
	const metadata = (primary.metadata ?? {}) as Record<string, unknown>
	const asked = typeof metadata.asked === 'string' ? metadata.asked : null
	const recommendation =
		typeof metadata.recommendation === 'string' ? metadata.recommendation : null

	const handleBulkApprove = () => {
		const payload = bulkResponseFor(group)
		if (!payload) {
			toast.error('This group has no recommended action to apply.')
			return
		}
		const ids = group.items.map((item) => item.id)
		bulkRespond.mutate(
			{ ids, response: payload.response },
			{
				onSuccess: (updated) =>
					toast.success(`Approved ${updated.length} ${updated.length === 1 ? 'item' : 'items'}`),
				onError: () => toast.error('Bulk approve failed — try again.'),
			},
		)
	}

	const handleSingleRespond = (response: unknown) => {
		singleRespond.mutate(
			{ id: primary.id, response },
			{
				onSuccess: () => toast.success('Responded'),
				onError: () => toast.error('Respond failed — try again.'),
			},
		)
	}

	const canBulkApprove = isGrouped && bulkResponseFor(group) !== null

	return (
		<article
			data-testid="foryou-group-card"
			data-object-id={group.objectId ?? ''}
			data-group-size={group.items.length}
			data-notification-id={primary.id}
			className="flex flex-col overflow-hidden rounded-[18px] border border-border bg-background shadow-md"
		>
			<header className="flex items-start gap-3 border-b border-border px-4 py-3">
				<div className="min-w-0 flex-1">
					{group.objectId ? (
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: group.objectId }}
							className="block truncate text-[15px] font-semibold leading-snug text-foreground hover:underline"
							title={primary.title}
						>
							{primary.title}
						</Link>
					) : (
						<span
							className="block truncate text-[15px] font-semibold leading-snug text-foreground"
							title={primary.title}
						>
							{primary.title}
						</span>
					)}
					<p className="mt-1 text-xs text-muted-foreground">
						{isGrouped ? (
							<>
								{group.items.length} notifications on this object
								{primary.type ? ` · ${primary.type}` : null}
							</>
						) : (
							<>{primary.type}</>
						)}
					</p>
				</div>
				{group.objectId && (
					<Button size="sm" variant="outline" className="h-8 shrink-0 text-xs" asChild>
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: group.objectId }}
						>
							Open →
						</Link>
					</Button>
				)}
			</header>

			<div className="space-y-2 px-4 py-3">
				{asked && (
					<p className="text-[13px] text-foreground">
						<span className="text-muted-foreground">Asked · </span>
						{asked}
					</p>
				)}
				{recommendation && (
					<p className="text-[13px] text-foreground">
						<span className="text-muted-foreground">Recommendation · </span>
						{recommendation}
					</p>
				)}
				{primary.content && !asked && !recommendation && (
					<p className="line-clamp-3 text-[13px] text-muted-foreground">{primary.content}</p>
				)}
			</div>

			{isGrouped && expanded && (
				<ul
					data-testid="foryou-group-expanded"
					className="border-t border-border bg-secondary/25 px-4 py-2 text-xs"
				>
					{group.items.map((item) => (
						<li
							key={item.id}
							className="flex items-center justify-between gap-2 border-b border-border/60 py-1.5 last:border-b-0"
							data-testid="foryou-group-item"
							data-notification-id={item.id}
						>
							<span className="truncate text-muted-foreground">{item.title}</span>
							<span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
								{item.type}
							</span>
						</li>
					))}
				</ul>
			)}

			<footer
				className={cn(
					'flex items-center justify-between gap-3 border-t border-border bg-background px-4 py-3',
					isGrouped ? 'flex-wrap' : null,
				)}
			>
				{isGrouped ? (
					<>
						<button
							type="button"
							onClick={() => setExpanded((prev) => !prev)}
							className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
							aria-expanded={expanded}
							data-testid="foryou-group-toggle"
						>
							<ChevronDown
								size={14}
								className={cn('transition-transform', expanded ? 'rotate-180' : null)}
							/>
							{expanded ? 'Hide items' : `Show ${group.items.length} items`}
						</button>
						<Button
							size="sm"
							disabled={!canBulkApprove || bulkRespond.isPending}
							onClick={handleBulkApprove}
							data-testid="foryou-bulk-approve"
							data-group-key={group.key}
						>
							<CheckIcon size={14} className="mr-1" />
							{canBulkApprove
								? `Approve all ${group.items.length}`
								: `${group.items.length} items — no recommendation`}
						</Button>
					</>
				) : (
					<SingleActions
						notification={primary}
						disabled={singleRespond.isPending}
						onRespond={handleSingleRespond}
					/>
				)}
			</footer>
		</article>
	)
}

interface SingleActionsProps {
	notification: NotificationResponse
	disabled: boolean
	onRespond: (response: unknown) => void
}

function SingleActions({ notification, disabled, onRespond }: SingleActionsProps) {
	const metadata = (notification.metadata ?? {}) as Record<string, unknown>
	const options = Array.isArray(metadata.options)
		? (metadata.options as Array<{ label?: string; value?: string; default?: boolean }>)
		: []

	if (options.length === 0) {
		if (notification.status === 'resolved') {
			return (
				<span
					className="text-xs text-muted-foreground"
					data-testid="foryou-single-status"
					data-status={notification.status}
				>
					Resolved
				</span>
			)
		}
		return (
			<span
				className="text-xs text-muted-foreground"
				data-testid="foryou-single-status"
				data-status={notification.status}
			>
				No options — open the object to respond
			</span>
		)
	}

	return (
		<div className="flex flex-wrap items-center gap-1.5">
			{options.map((option) => {
				const label = option.label ?? option.value ?? 'Option'
				const value = option.value ?? option.label ?? label
				return (
					<Button
						key={value}
						size="sm"
						variant={option.default ? 'default' : 'outline'}
						disabled={disabled}
						onClick={() => onRespond(value)}
						data-testid="foryou-single-option"
						data-option-value={value}
					>
						{label}
					</Button>
				)
			})}
		</div>
	)
}
