/**
 * What a live call leaves in its thread: one small row per real change while
 * the call runs, and a summary card when it ends. Both are drawn from the
 * `receipt` / `receipt_summary` messages `parseVoiceReceipt` reads; the
 * transcript stays out of the thread until the card's button asks for it.
 */

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import {
	type VoiceReceiptEvent,
	type VoiceReceiptRow,
	type VoiceReceiptSummary,
	formatCallClock,
	voiceReceiptLabel,
} from '@/lib/voice-receipts'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

// Left offset lines the row up with message text, past the 28px avatar and gap.
const ROW_OFFSET = 'ml-[39px]'

function dotClass(event: VoiceReceiptEvent): string {
	switch (event) {
		case 'created_bet':
			return 'bg-foreground'
		case 'created_task':
		case 'opened_task':
			return 'bg-brand/60'
		case 'decided':
		case 'moved_to_review':
			return 'bg-brand'
		default:
			return 'bg-muted-foreground'
	}
}

function typeDotClass(type: string): string {
	return type === 'bet' ? 'bg-foreground' : type === 'task' ? 'bg-brand/60' : 'bg-muted-foreground'
}

function ObjectLink({
	workspaceId,
	objectId,
	className,
	children,
}: {
	workspaceId: string
	objectId: string | null
	className?: string
	children: ReactNode
}) {
	if (!objectId) return <div className={className}>{children}</div>
	return (
		<Link
			to="/$workspaceId/objects/$objectId"
			params={{ workspaceId, objectId }}
			className={cn('no-underline hover:border-[color:var(--border-strong)]', className)}
		>
			{children}
		</Link>
	)
}

export function VoiceEventRow({
	receipt,
	workspaceId,
}: {
	receipt: VoiceReceiptRow
	workspaceId: string
}) {
	const failed = receipt.outcome !== 'ran'
	return (
		<ObjectLink
			workspaceId={workspaceId}
			objectId={receipt.objectId}
			className={cn(
				ROW_OFFSET,
				'flex max-w-[660px] flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground',
			)}
		>
			<span data-testid="voice-event-time" className="font-mono text-[10px] text-muted-foreground">
				{formatCallClock(receipt.t)}
			</span>
			<span
				aria-hidden="true"
				className={cn('size-2 shrink-0 self-center rounded-full', dotClass(receipt.event))}
			/>
			<span className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
				{failed
					? receipt.outcome === 'failed'
						? 'Failed'
						: 'Not done'
					: voiceReceiptLabel(receipt.event)}
			</span>
			<span className={cn('min-w-0 flex-1', failed && 'text-muted-foreground')}>
				{receipt.text}
			</span>
		</ObjectLink>
	)
}

function SummarySection({ label, children }: { label: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-1.5">
			<h4 className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
				{label}
			</h4>
			{children}
		</section>
	)
}

/** Keys for a list of plain strings: the text, with a count added to a repeat. */
function keyed(items: string[]): { key: string; text: string }[] {
	const seen = new Map<string, number>()
	return items.map((text) => {
		const n = seen.get(text) ?? 0
		seen.set(text, n + 1)
		return { key: n === 0 ? text : `${text}#${n}`, text }
	})
}

function CheckList({ items }: { items: string[] }) {
	return (
		<ul className="flex flex-col gap-1">
			{keyed(items).map(({ key, text }) => (
				<li key={key} className="flex items-start gap-2 text-sm text-foreground">
					<Check size={14} aria-hidden="true" className="mt-0.5 shrink-0 text-brand" />
					<span className="min-w-0">{text}</span>
				</li>
			))}
		</ul>
	)
}

export function VoiceSummaryCard({
	summary,
	workspaceId,
	title,
	canReadTranscript,
	onReadTranscript,
}: {
	summary: VoiceReceiptSummary
	workspaceId: string
	/** The agent-written body of the summary message, when it has one. */
	title?: string
	canReadTranscript: boolean
	/** Opens the full Transcript view. */
	onReadTranscript: (trigger: HTMLButtonElement) => void
}) {
	return (
		<article
			aria-label="Live meeting summary"
			className={cn(
				ROW_OFFSET,
				'flex max-w-[660px] flex-col gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm',
			)}
		>
			<header className="flex items-center justify-between gap-3">
				<span className="rounded-full bg-brand-subtle px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-brand-subtle-foreground">
					Live meeting
				</span>
				<span className="font-mono text-[13px] font-semibold text-muted-foreground">
					{formatCallClock(summary.durationSeconds)}
				</span>
			</header>
			{title ? <p className="text-base font-bold tracking-tight text-foreground">{title}</p> : null}
			{summary.decided.length > 0 ? (
				<SummarySection label={`Decided · ${summary.decided.length}`}>
					<CheckList items={summary.decided} />
				</SummarySection>
			) : null}
			{summary.created.length > 0 ? (
				<SummarySection label={`Created · ${summary.created.length}`}>
					<ul className="flex flex-wrap gap-1.5">
						{summary.created.map((c, i) => (
							<li key={c.objectId ?? `${c.type}-${c.title}-${i}`}>
								<ObjectLink
									workspaceId={workspaceId}
									objectId={c.objectId}
									className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-background px-2.5 py-1 text-xs font-semibold text-foreground"
								>
									<span
										aria-hidden="true"
										className={cn('size-2 shrink-0 rounded-full', typeDotClass(c.type))}
									/>
									<span className="min-w-0 truncate">{c.title}</span>
								</ObjectLink>
							</li>
						))}
					</ul>
				</SummarySection>
			) : null}
			{summary.next.length > 0 ? (
				<SummarySection label="Next">
					<CheckList items={summary.next} />
				</SummarySection>
			) : null}
			{summary.notDone.length > 0 ? (
				<SummarySection label={`Not done · ${summary.notDone.length}`}>
					<ul className="flex flex-col gap-1">
						{keyed(summary.notDone).map(({ key, text }) => (
							<li key={key} className="text-sm text-muted-foreground">
								{text}
							</li>
						))}
					</ul>
				</SummarySection>
			) : null}
			{canReadTranscript ? (
				<footer>
					<Button type="button" size="sm" onClick={(e) => onReadTranscript(e.currentTarget)}>
						Read transcript
					</Button>
				</footer>
			) : null}
		</article>
	)
}
