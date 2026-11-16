import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActors } from '@/hooks/use-actors'
import { useObject } from '@/hooks/use-objects'
import type { NextStep } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'

/** True when an open step is past its due time. A blocked step waits on something named. */
export function isNextStepOverdue(step: Pick<NextStep, 'status' | 'due_at'>, now = Date.now()) {
	return step.status === 'open' && new Date(step.due_at).getTime() < now
}

function formatDue(iso: string): string {
	return new Date(iso).toLocaleString(undefined, {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false,
	})
}

/**
 * `<NextStepBlock>` — what happens next on this object, who does it and when. Renders NOTHING
 * when the object has no open or blocked step. Placed at the top of the Overview tab, between
 * the Origin block and the ask banner. An overdue date shows in the warning colour.
 */
export function NextStepBlock({
	step,
	workspaceId,
}: {
	step: NextStep | null | undefined
	workspaceId: string
}) {
	const { data: actors } = useActors(workspaceId, { enabled: !!step })
	if (!step) return null

	const owner = actors?.find((a) => a.id === step.owner_id)
	const overdue = isNextStepOverdue(step)

	return (
		<section
			aria-label="Next step"
			data-next-step
			data-overdue={overdue ? 'true' : undefined}
			className="mt-3.5 rounded-[11px] border border-border-subtle bg-surface-sunken px-[11px] py-[9px]"
		>
			<p className="text-[10px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
				Next step
			</p>
			<p className="mt-1 text-[13px] leading-[1.45] text-foreground">{step.action}</p>
			<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
				{owner && (
					<span className="inline-flex items-center gap-1.5">
						<ActorAvatar
							id={owner.id}
							name={owner.name}
							type={owner.type}
							size="sm"
							className="size-4 shrink-0 text-[7.5px]"
						/>
						{owner.name}
					</span>
				)}
				<span className={cn(overdue && 'font-medium text-warning')}>
					{overdue ? 'Overdue · ' : 'Due '}
					<time dateTime={step.due_at}>{formatDue(step.due_at)}</time>
				</span>
			</div>
			{step.status === 'blocked' && <BlockedOn step={step} workspaceId={workspaceId} />}
		</section>
	)
}

function BlockedOn({ step, workspaceId }: { step: NextStep; workspaceId: string }) {
	const { data: actors } = useActors(workspaceId, { enabled: !!step.blocked_on_actor_id })
	const { data: blocker } = useObject(step.blocked_on_object_id ?? '', {
		enabled: !!step.blocked_on_object_id,
	})

	let waitingOn: ReactNode = null
	if (step.blocked_on_object_id) {
		waitingOn = (
			<Link
				to="/$workspaceId/objects/$objectId"
				params={{ workspaceId, objectId: step.blocked_on_object_id }}
				className="font-medium text-foreground hover:text-brand"
			>
				{blocker?.title ?? 'another item'}
			</Link>
		)
	} else if (step.blocked_on_actor_id) {
		waitingOn = (
			<span className="font-medium text-foreground">
				{actors?.find((a) => a.id === step.blocked_on_actor_id)?.name ?? 'an answer'}
			</span>
		)
	} else if (step.blocked_on_decision_comment_id !== null) {
		waitingOn = <span className="font-medium text-foreground">a decision</span>
	}

	return (
		<p className="mt-1.5 text-[11.5px] leading-[1.45] text-muted-foreground">
			Blocked, waiting on {waitingOn}
			{step.blocked_reason ? `: ${step.blocked_reason}` : ''}
		</p>
	)
}
