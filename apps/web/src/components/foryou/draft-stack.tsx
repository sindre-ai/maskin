import { Button } from '@/components/ui/button'
import type { LatestMentionDecisionDraft } from '@/lib/api'
import { Check } from 'lucide-react'
import { useRef, useState } from 'react'
import { DraftPreview } from './draft-preview'

export type DraftAction = 'send' | 'skip'

interface DraftStackProps {
	workspaceId: string
	drafts: readonly LatestMentionDecisionDraft[]
	/** Posts the reader's call on one message. Rejects when the reply could not be sent. */
	onAction: (draft: LatestMentionDecisionDraft, action: DraftAction) => Promise<unknown>
	/** Every message has been sent or skipped. */
	onAllDone: () => void
}

const keyOf = (draft: LatestMentionDecisionDraft, index: number) => draft.id ?? String(index)

/**
 * One card, several messages: each is its own preview with its own Send and Skip,
 * stacked so the reader can decide them one at a time (the card's own bar decides them all). Sending reaches a real person,
 * so it asks for a second tap before it goes. A message that has been dealt with
 * folds down to a one-line receipt, and the card settles once the last one is.
 */
export function DraftStack({ workspaceId, drafts, onAction, onAllDone }: DraftStackProps) {
	const [done, setDone] = useState<ReadonlyMap<string, DraftAction>>(new Map())
	const [confirming, setConfirming] = useState<string | null>(null)
	const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
	const [failed, setFailed] = useState<string | null>(null)
	// Two acts on different messages can overlap, so what has been dealt with is
	// read from a ref (always current) rather than from the render's `done`. A
	// stale copy dropped one entry and the card never settled.
	const doneRef = useRef<ReadonlyMap<string, DraftAction>>(done)
	const inFlight = useRef<Set<string>>(new Set())

	const setPendingKey = (key: string, on: boolean) =>
		setPending((prev) => {
			const next = new Set(prev)
			if (on) next.add(key)
			else next.delete(key)
			return next
		})

	const act = async (draft: LatestMentionDecisionDraft, index: number, action: DraftAction) => {
		const key = keyOf(draft, index)
		if (doneRef.current.has(key) || inFlight.current.has(key)) return
		inFlight.current.add(key)
		setPendingKey(key, true)
		setFailed(null)
		try {
			await onAction(draft, action)
		} catch {
			inFlight.current.delete(key)
			setFailed(key)
			setPendingKey(key, false)
			return
		}
		inFlight.current.delete(key)
		doneRef.current = new Map(doneRef.current).set(key, action)
		setDone(doneRef.current)
		setPendingKey(key, false)
		setConfirming(null)
		if (doneRef.current.size === drafts.length) onAllDone()
	}

	return (
		<div className="flex flex-col gap-2">
			{drafts.map((draft, index) => {
				const key = keyOf(draft, index)
				const outcome = done.get(key)
				const name = draft.to ?? draft.label ?? 'message'
				if (outcome) {
					return (
						<p
							key={key}
							className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[12.5px] text-muted-foreground"
						>
							<Check size={14} aria-hidden className="shrink-0" />
							{outcome === 'send' ? 'Told the agent to send' : 'Skipped'} · {name}
						</p>
					)
				}
				const busy = pending.has(key)
				return (
					<div key={key} className="flex flex-col gap-2">
						<DraftPreview workspaceId={workspaceId} draft={draft} />
						<div className="flex flex-wrap items-center gap-2">
							{confirming === key ? (
								<>
									<Button
										type="button"
										size="sm"
										disabled={busy}
										onClick={() => act(draft, index, 'send')}
									>
										Confirm send to {name}
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => setConfirming(null)}
									>
										Cancel
									</Button>
								</>
							) : (
								<>
									{/* Quiet on purpose: the card's own bar is the main action, this is
									    for sending one reply on its own. */}
									<Button
										type="button"
										size="sm"
										variant="outline"
										disabled={busy}
										onClick={() => setConfirming(key)}
									>
										Send
									</Button>
									<Button
										type="button"
										size="sm"
										variant="ghost"
										disabled={busy}
										onClick={() => act(draft, index, 'skip')}
									>
										Skip
									</Button>
								</>
							)}
							{failed === key ? (
								<span role="alert" className="text-xs text-destructive">
									Could not send your reply. Try again.
								</span>
							) : null}
						</div>
					</div>
				)
			})}
		</div>
	)
}
