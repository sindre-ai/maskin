import type { InputOption } from '@/components/pulse/notification-input'
import { useRespondNotification } from '@/hooks/use-notifications'
import { cn } from '@/lib/cn'
import { Check, CornerDownLeft } from 'lucide-react'

/**
 * View shape of a `needs_input` notification bound to the conversation —
 * derived from the notification's metadata + persisted response.
 */
export interface Ask {
	id: string
	title: string | null
	content: string | null
	question: string | null
	options: InputOption[]
	/** `metadata.suggestion` — the producer's recommended option, shown as a REC chip. */
	suggestion: string | null
	status: string
	response: unknown
}

interface AskBlockProps {
	workspaceId: string
	ask: Ask
}

/**
 * Renders a `needs_input` notification as a tappable decision block inside the
 * conversation (the Generative UI handoff precedent: agent → human handoffs
 * use inline choices). Tapping an option responds immediately — no confirm
 * step — matching the mockup's "tap to choose" ask rows. Once resolved the
 * block locks and shows which option was picked.
 */
export function AskBlock({ workspaceId, ask }: AskBlockProps) {
	const respond = useRespondNotification(workspaceId)
	const resolved = ask.status === 'resolved'
	const respondingId = respond.isPending ? respond.variables?.id : undefined

	return (
		<div className="w-full max-w-sm rounded-md border border-border bg-bg p-3">
			<div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
				<CornerDownLeft size={10} aria-hidden className="shrink-0" />
				<span>Ask</span>
			</div>
			{ask.question ? <p className="text-sm font-medium text-text">{ask.question}</p> : null}
			{ask.content ? <p className="mt-1 text-xs text-text-secondary">{ask.content}</p> : null}
			{ask.title && !ask.question && !ask.content ? (
				<p className="text-sm font-medium text-text">{ask.title}</p>
			) : null}
			<ul className="mt-2 flex flex-col gap-1">
				{ask.options.map((opt) => {
					const isRec = opt.value === ask.suggestion || opt.label === ask.suggestion
					const isChosen = resolved && String(ask.response) === opt.value
					const isResponding = respondingId === ask.id && !resolved
					return (
						<li key={opt.value}>
							<button
								type="button"
								disabled={resolved || isResponding}
								onClick={() => respond.mutate({ id: ask.id, response: opt.value })}
								aria-pressed={isChosen}
								className={cn(
									'flex w-full items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-left transition-colors',
									isChosen && 'border-accent',
									resolved
										? 'cursor-default opacity-70'
										: 'hover:bg-bg-hover focus-visible:bg-bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
								)}
							>
								<span className="flex min-w-0 flex-1 flex-col gap-0.5">
									<span className="flex items-center gap-1.5 font-medium text-text">
										<span className="truncate">{opt.label}</span>
										{isRec ? (
											<span className="shrink-0 rounded-full bg-accent px-1.5 py-px text-[9px] font-bold uppercase tracking-wider text-accent-foreground">
												REC
											</span>
										) : null}
									</span>
									{opt.description ? (
										<span className="text-xs text-text-secondary">{opt.description}</span>
									) : null}
								</span>
								{isChosen ? (
									<Check size={14} className="mt-0.5 shrink-0 text-accent" aria-label="Picked" />
								) : null}
							</button>
						</li>
					)
				})}
			</ul>
		</div>
	)
}
