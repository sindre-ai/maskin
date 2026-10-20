import { FormError } from '@/components/shared/form-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { useSendMessage } from '@/hooks/use-conversation'
import { useDraftTransition, useObject } from '@/hooks/use-objects'
import type { MessageDraft } from '@/lib/api'
import { cn } from '@/lib/cn'
import { type DraftTransition, draftKindName, readDraftTaskState } from '@maskin/shared'
import { Check, RotateCcw } from 'lucide-react'
import { useState } from 'react'

/**
 * `email` is the only kind with its own layout and wording. Every other kind is
 * plain text, labelled by `label` / `approve_label` or by its own identifier, so a
 * new channel (instagram_caption, tiktok_caption, ...) needs no change here.
 */
function wording(draft: MessageDraft) {
	const isEmail = draft.kind === 'email'
	return {
		chip:
			(draft.label ?? draftKindName(draft.kind)).toUpperCase() +
			(isEmail && !draft.label ? ' DRAFT' : ''),
		approve: draft.approve_label ?? (isEmail ? 'Approve and send' : 'Approve'),
		done: isEmail ? 'Approved to send' : 'Approved',
	}
}

/** Past this many characters a draft folds to a few lines until opened. */
const FOLD_AFTER = 260

interface DraftCardProps {
	workspaceId: string
	conversationId: string
	/** The agent that posted the draft; approving addresses it, so it knows to send. */
	agentId: string
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
 * Every change goes through the server's draft transition, which checks the state
 * this card last saw against the locked row. A stale tab therefore cannot edit text
 * that was already approved, and when two tabs approve only one gets a yes back, so
 * only one tells the agent.
 *
 * Approving records the person's yes on the task and then says so in the chat,
 * addressed to the agent that wrote the draft. The agent receives that as its next
 * turn, reads the task and sends what is saved there. If that message fails the card
 * says so and offers to send it again, rather than showing "Approved" for a draft the
 * agent was never told about. Undo only flips the task back; the agent is told to
 * check the state before it sends.
 */
export function DraftCard({ workspaceId, conversationId, agentId, draft }: DraftCardProps) {
	const { data: task } = useObject(draft.object_id)
	const transition = useDraftTransition(workspaceId)
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// Unsaved typing. `null` means "show what the task says", so a change made
	// elsewhere (another tab, the agent revising) shows through until the person
	// starts typing here.
	const [body, setBody] = useState<string | null>(null)
	const [subject, setSubject] = useState<string | null>(null)
	const [expanded, setExpanded] = useState(false)

	const state = readDraftTaskState(task?.metadata)
	if (!task || !state) return null

	const kind = wording(draft)
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

	// Typing is only dropped once the server has accepted the change, so a failed
	// save leaves the person's text on screen next to the error.
	const run = (data: DraftTransition, onDone?: () => void) => {
		transition.mutate(
			{ id: task.id, data },
			{
				onSuccess: () => {
					setBody(null)
					setSubject(null)
					onDone?.()
				},
			},
		)
	}

	const textFields = () => ({
		body: shownBody,
		...(draft.kind === 'email' ? { subject: shownSubject } : {}),
	})

	const notifyAgent = () => {
		const what = `${draft.label ?? draftKindName(draft.kind)}${draft.to ? ` to ${draft.to}` : ''}`
		sendMessage.mutate({
			content: `Approved the ${what}. Send it exactly as saved in task ${task.id}.`,
			metadata: { mentions: [agentId] },
		})
	}

	// Tell the agent in the chat, after the task holds the approved text, so the
	// agent never reads a task that has not caught up with the card.
	const approve = () =>
		run({ action: 'approve', expected_state: 'draft', ...textFields() }, notifyAgent)

	const undo = () => {
		sendMessage.reset()
		run({ action: 'undo', expected_state: 'approved' })
	}

	const restore = () => run({ action: 'restore', expected_state: 'draft' })

	const commit = () => {
		if (shownBody !== savedBody || shownSubject !== savedSubject) {
			run({ action: 'edit', expected_state: 'draft', ...textFields() })
		}
	}

	// Blurring the text to press Approve starts a save before the click lands, so only
	// an approval in flight may disable the button; disabling it for the save would
	// swallow the click.
	const approving = transition.isPending && transition.variables?.data.action === 'approve'

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
				<div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1 text-sm font-medium">
					<Check size={16} aria-hidden className="shrink-0" />
					<span className="flex-1">{kind.done}</span>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={transition.isPending}
						onClick={undo}
					>
						Undo
					</Button>
					{sendMessage.isError ? (
						<div className="flex w-full items-center gap-2 text-xs font-normal text-error">
							<span className="flex-1">Approved, but the agent was not told.</span>
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={sendMessage.isPending}
								onClick={notifyAgent}
							>
								Tell the agent
							</Button>
						</div>
					) : null}
				</div>
			) : (
				<div className="flex flex-col gap-2 px-3 pb-3 pt-1 sm:flex-row">
					{edited ? (
						<Button
							type="button"
							variant="outline"
							disabled={transition.isPending}
							onClick={restore}
						>
							<RotateCcw size={15} aria-hidden />
							Restore original
						</Button>
					) : null}
					<Button
						type="button"
						className="flex-1"
						disabled={overLimit || shownBody.trim() === '' || approving}
						onClick={approve}
					>
						{kind.approve}
					</Button>
				</div>
			)}
			<FormError error={transition.error?.message} className="px-3 pb-3 pt-0" />
		</div>
	)
}
