import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import type { ActorListItem } from '@/lib/api'
import { typeLabel } from '@/lib/constants'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'

export interface DecisionRow {
	item: { id: string; title: string | null; type: string }
	ask: {
		title: string
		createdAt: string | null
		sourceActorId: string | null
	}
}

function plural(noun: string, n: number): string {
	return n === 1 ? noun : `${noun}s`
}

/**
 * The flow page's Decisions card: what is waiting on the viewer in this flow, one row
 * per item with the question it is asked. A row opens the item, where the answer is given;
 * the ticks let a reader pick out the ones to take together. "Message" brings the flow's
 * own composer into reach.
 */
export function LoopDecisions({
	workspaceId,
	rows,
	actors,
	messageLabel,
	onMessage,
}: {
	workspaceId: string
	rows: DecisionRow[]
	actors: ActorListItem[] | undefined
	/** Who the Message button writes to, e.g. the flow's driver. */
	messageLabel?: string
	onMessage?: () => void
}) {
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
	if (rows.length === 0) return null

	const types = new Set(rows.map((r) => r.item.type))
	const noun = types.size === 1 ? typeLabel([...types][0] as string).toLowerCase() : 'item'
	const agentIds = [...new Set(rows.map((r) => r.ask.sourceActorId).filter(Boolean))] as string[]
	const agent = agentIds.length === 1 ? actors?.find((a) => a.id === agentIds[0]) : undefined
	const oldest = rows
		.map((r) => r.ask.createdAt)
		.filter((d): d is string => !!d)
		.sort()[0]
	const allPicked = picked.size === rows.length

	function toggle(id: string, on: boolean) {
		setPicked((prev) => {
			const next = new Set(prev)
			if (on) next.add(id)
			else next.delete(id)
			return next
		})
	}

	return (
		<section
			id="loop-decisions"
			aria-label="Decisions"
			data-testid="loop-needs-you"
			className="flex flex-col gap-3"
		>
			<h2 className="px-1 text-[13px] font-semibold text-muted-foreground">Decisions</h2>
			<div
				data-testid="loop-decisions-card"
				className="overflow-hidden rounded-xl border border-border bg-background shadow-xs"
			>
				<div className="flex flex-col gap-1 px-5 pb-3 pt-4">
					<p className="text-base font-bold leading-[1.32] tracking-tight text-foreground">
						{rows.length} {plural(noun, rows.length)} {rows.length === 1 ? 'is' : 'are'} waiting for
						you
					</p>
					<p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px] text-muted-foreground">
						{agent && (
							<>
								<ActorAvatar id={agent.id} name={agent.name} type={agent.type} />
								<span>{agent.name}</span>
							</>
						)}
						{oldest && (
							<span>
								{agent ? '· ' : ''}oldest waiting <RelativeTime date={oldest} />
							</span>
						)}
					</p>
				</div>
				<ul>
					{rows.map(({ item, ask }) => (
						<li
							key={item.id}
							className="flex items-center gap-3 border-t border-border px-5 py-2.5"
						>
							<Checkbox
								checked={picked.has(item.id)}
								onCheckedChange={(v) => toggle(item.id, v === true)}
								aria-label={`Select ${item.title ?? 'Untitled'}`}
							/>
							<Link
								to="/$workspaceId/objects/$objectId"
								params={{ workspaceId, objectId: item.id }}
								className="min-w-0 flex-1 hover:underline"
							>
								<span className="block truncate text-[13.5px] font-semibold text-foreground">
									{item.title ?? 'Untitled'}
								</span>
								<span className="mt-px block truncate text-xs text-muted-foreground">
									{ask.title}
								</span>
							</Link>
						</li>
					))}
				</ul>
				<div className="flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="rounded-full text-[13px] font-semibold text-muted-foreground"
						onClick={() => setPicked(allPicked ? new Set() : new Set(rows.map((r) => r.item.id)))}
					>
						{allPicked ? 'Clear selection' : 'Select all'}
					</Button>
					{onMessage && (
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="rounded-full text-[13px] font-semibold"
							onClick={onMessage}
						>
							{messageLabel ? `Message ${messageLabel}` : 'Message'}
						</Button>
					)}
					{picked.size > 0 && (
						<span className="ml-auto text-xs text-muted-foreground">{picked.size} selected</span>
					)}
				</div>
			</div>
		</section>
	)
}
