import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useObject, useUpdateObject } from '@/hooks/use-objects'
import type { DraftKind, MessageDraft } from '@/lib/api'
import { cn } from '@/lib/cn'
import { type DraftTaskState, draftTaskStateToMetadata, readDraftTaskState } from '@maskin/shared'
import { Check, RotateCcw } from 'lucide-react'
import { useState } from 'react'

/** Chip text and button verb per kind. A new `DraftKind` is a new row here. */
const KINDS: Record<DraftKind, { chip: string; approve: string; done: string }> = {
	email: { chip: 'EMAIL DRAFT', approve: 'Approve and send', done: 'Approved to send' },
	linkedin_post: { chip: 'LINKEDIN POST', approve: 'Approve and post', done: 'Approved to post' },
	linkedin_message: {
		chip: 'LINKEDIN MESSAGE',
		approve: 'Approve and send',
		done: 'Approved to send',
	},
}

/** Past this many characters a draft folds to a few lines until opened. */
const FOLD_AFTER = 260

interface DraftCardProps {
	workspaceId: string
	draft: MessageDraft
}

/**
 * An agent's draft of an email, post or message, shown where the person is
 * already reading so it can be edited and approved without leaving the chat.
 *
 * The text is not on the message. This card reads the task `draft.object_id`
 * live and writes edits back to it, so the chat, For you and the task page stay
 * one record, and a scrolled-back thread never shows a stale draft. If the task
 * is gone or carries no draft state the card renders nothing: the message's own
 * markdown already contains the text, so the thread still reads fine.
 *
 * Approving only records the person's yes on the task. What happens next (the
 * agent sending) is the agent's job, triggered by that update.
 */
export function DraftCard({ workspaceId, draft }: DraftCardProps) {
	const { data: task } = useObject(draft.object_id)
	const update = useUpdateObject(workspaceId)
	// Unsaved typing. `null` means "show what the task says", so a change made
	// elsewhere (another tab, the agent revising) shows through until the person
	// starts typing here.
	const [body, setBody] = useState<string | null>(null)
	const [subject, setSubject] = useState<string | null>(null)
	const [expanded, setExpanded] = useState(false)

	const state = readDraftTaskState(task?.metadata)
	if (!task || !state) return null

	const kind = KINDS[draft.kind]
	const savedBody = task.content ?? ''
	const savedSubject = state.subject ?? ''
	const shownBody = body ?? savedBody
	const shownSubject = subject ?? savedSubject
	const approved = state.state === 'approved'
	const edited =
		shownBody !== state.original_body ||
		(draft.kind === 'email' && shownSubject !== (state.original_subject ?? ''))
	const overLimit = draft.char_limit !== undefined && shownBody.length > draft.char_limit
	const folded = !expanded && !approved && shownBody.length > FOLD_AFTER
	const status = approved ? 'Approved' : edited ? 'Edited' : 'Draft'

	const save = (next: { body: string; subject: string; state?: DraftTaskState['state'] }) => {
		const nextState: DraftTaskState = {
			...state,
			state: next.state ?? state.state,
			...(draft.kind === 'email' ? { subject: next.subject } : {}),
			approved_at: undefined,
		}
		if (nextState.state === 'approved') nextState.approved_at = new Date().toISOString()
		update.mutate({
			id: task.id,
			data: {
				content: next.body,
				metadata: { ...task.metadata, ...draftTaskStateToMetadata(nextState) },
			},
		})
		setBody(null)
		setSubject(null)
	}

	const commit = () => {
		if (shownBody !== savedBody || shownSubject !== savedSubject) {
			save({ body: shownBody, subject: shownSubject })
		}
	}

	return (
		<div className="mt-2 max-w-[660px] overflow-hidden rounded-xl border border-border bg-card">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<span className="shrink-0 rounded-md bg-secondary px-2 py-1 font-mono text-[10px] font-semibold tracking-[0.08em] text-secondary-foreground">
					{kind.chip}
				</span>
				<span className="flex-1" />
				<Badge variant={approved ? 'default' : 'secondary'}>{status}</Badge>
			</div>

			{draft.kind === 'email' ? (
				<div className="flex flex-col gap-2 px-3 pt-3">
					{draft.to ? (
						<p className="text-sm text-muted-foreground">
							To <span className="font-medium text-foreground">{draft.to}</span>
						</p>
					) : null}
					<Input
						aria-label="Subject"
						value={shownSubject}
						disabled={approved}
						onChange={(e) => setSubject(e.target.value)}
						onBlur={commit}
						className="font-semibold"
					/>
				</div>
			) : null}

			<div className="px-3 pt-3">
				<div className={cn('relative', folded && 'max-h-32 overflow-hidden')}>
					<Textarea
						autoResize
						aria-label="Draft text"
						value={shownBody}
						disabled={approved}
						spellCheck={false}
						onChange={(e) => setBody(e.target.value)}
						onFocus={() => setExpanded(true)}
						onBlur={commit}
						className="min-h-[120px] resize-none leading-relaxed"
					/>
					{folded ? (
						<div
							aria-hidden
							className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent"
						/>
					) : null}
				</div>
				<div className="flex items-center justify-between gap-2 pt-1 text-xs text-muted-foreground">
					{shownBody.length > FOLD_AFTER && !approved ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setExpanded((v) => !v)}
							className="-ml-2 h-8 px-2 text-xs"
						>
							{expanded ? 'Show less' : 'Show all'}
						</Button>
					) : (
						<span />
					)}
					{draft.char_limit !== undefined ? (
						<span className={cn(overLimit && 'font-semibold text-destructive')}>
							{shownBody.length} / {draft.char_limit}
						</span>
					) : null}
				</div>
			</div>

			{approved ? (
				<div className="flex items-center gap-2 px-3 pb-3 pt-1 text-sm font-medium">
					<Check size={16} aria-hidden className="shrink-0" />
					<span className="flex-1">{kind.done}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => save({ body: savedBody, subject: savedSubject, state: 'draft' })}
					>
						Undo
					</Button>
				</div>
			) : (
				<div className="flex flex-col gap-2 px-3 pb-3 pt-1 sm:flex-row">
					{edited ? (
						<Button
							type="button"
							variant="outline"
							onClick={() =>
								save({ body: state.original_body, subject: state.original_subject ?? '' })
							}
						>
							<RotateCcw size={15} aria-hidden />
							Restore original
						</Button>
					) : null}
					<Button
						type="button"
						className="flex-1"
						disabled={overLimit || shownBody.trim() === '' || update.isPending}
						onClick={() => save({ body: shownBody, subject: shownSubject, state: 'approved' })}
					>
						{kind.approve}
					</Button>
				</div>
			)}
		</div>
	)
}
