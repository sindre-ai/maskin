import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useCanWrite } from '@/hooks/use-can-write'
import { useSendMessage } from '@/hooks/use-conversation'
import { useSendSessionInput } from '@/hooks/use-sessions'
import type { MessageQuestion, MessageQuestionAnswer, MessageQuestionItem } from '@/lib/api'
import { cn } from '@/lib/cn'
import { Check } from 'lucide-react'
import { useState } from 'react'

interface QuestionOptionsProps {
	conversationId: string
	workspaceId: string
	/** `messages.id` of the message carrying the question. */
	questionMessageId: number
	question: MessageQuestion
	/** A later message in the thread already answered this one. */
	answered: boolean
	/** Sits at the right end of the action row, beside "Send answer". */
	trailingAction?: React.ReactNode
}

/**
 * Renders an agent's AskUserQuestion as selectable options under its message.
 *
 * The headless CLI can't render that tool itself, so a PreToolUse hook posts
 * the questions here instead (docker/agent-base/hooks/ask-user-question.sh).
 * Answering posts an ordinary chat message — the conversation responder feeds
 * it to the waiting agent as its next turn, so nothing new is needed on the
 * delivery side.
 *
 * Once answered the options collapse to a read-only summary rather than
 * disappearing: the thread should still show what was asked and what was
 * picked when scrolled back through later.
 */
export function QuestionOptions({
	conversationId,
	workspaceId,
	questionMessageId,
	question,
	answered,
	trailingAction,
}: QuestionOptionsProps) {
	// question index -> chosen labels. Deliberately NOT keyed by header: nothing
	// makes headers unique (the schema validates each one independently, and the
	// hook defaults every unheadered question to the literal "Question"), so two
	// colliding headers would share one state entry — one click selecting both
	// questions, and `allAnswered` passing on a single pick. The header is still
	// what goes back out in the answer payload; it is just not an identity.
	const [picked, setPicked] = useState<Record<number, string[]>>({})
	// Free-text reply, for when none of the options fit.
	const [typing, setTyping] = useState(false)
	const [typed, setTyped] = useState('')
	const sendMessage = useSendMessage(conversationId, workspaceId)
	// A helper another agent started is not in this chat, so its answer goes to
	// the session itself, not to the chat's agents.
	const sendInput = useSendSessionInput(workspaceId)
	// An answer is a message to the agent, which a viewer cannot send.
	const canWrite = useCanWrite()
	const isPending = sendMessage.isPending || sendInput.isPending
	const isError = sendMessage.isError || sendInput.isError

	if (answered) return null

	const toggle = (q: MessageQuestionItem, index: number, label: string) => {
		setPicked((prev) => {
			const current = prev[index] ?? []
			if (!q.multi_select) return { ...prev, [index]: [label] }
			return {
				...prev,
				[index]: current.includes(label) ? current.filter((l) => l !== label) : [...current, label],
			}
		})
	}

	const answers = question.questions
		.map((q, i) => ({ header: q.header, selected: picked[i] ?? [] }))
		.filter((a) => a.selected.length > 0)
	const allAnswered = answers.length === question.questions.length

	const sendAnswer = (content: string, questionAnswer: MessageQuestionAnswer) => {
		if (question.reply_to_session) {
			sendInput.mutate({
				id: question.session_id,
				content,
				question_answer: questionAnswer,
				conversationId,
			})
			return
		}
		sendMessage.mutate({ content, metadata: { question_answer: questionAnswer } })
	}

	const submitTyped = () => {
		const text = typed.trim()
		if (!text || isPending) return
		// The answer metadata only pairs the reply to its question and caps each pick
		// at 200 characters; the message content carries the full text.
		sendAnswer(text, {
			question_message_id: questionMessageId,
			answers: [
				{ header: question.questions[0]?.header ?? 'Question', selected: [text.slice(0, 200)] },
			],
		})
	}

	const submit = () => {
		if (!allAnswered || isPending) return
		// The content is what the agent actually reads, so it repeats the question
		// alongside the pick — the agent's next turn arrives without the chip UI's
		// context, and "API token" alone would be ambiguous across two questions.
		const content = question.questions
			.map((q, i) => `**${q.header}** — ${q.question}\n${(picked[i] ?? []).join(', ')}`)
			.join('\n\n')
		sendAnswer(content, { question_message_id: questionMessageId, answers })
	}

	return (
		<div className="mt-2 flex flex-col gap-3">
			{question.questions.map((q, index) => {
				const chosen = picked[index] ?? []
				return (
					// Index as key for the same reason the state is index-keyed: headers
					// are not unique, and the list is a fixed snapshot from one immutable
					// message that never reorders.
					// biome-ignore lint/suspicious/noArrayIndexKey: headers are not unique
					<fieldset key={index} className="flex flex-col gap-1.5 border-0 p-0">
						<legend className="eyebrow">{q.header}</legend>
						<p className="text-[13.5px] leading-[1.5] text-foreground">{q.question}</p>
						<ViewerTooltip className="block">
							<ul className="flex list-none flex-wrap gap-1.5 p-0">
								{q.options.map((option) => {
									const isChosen = chosen.includes(option.label)
									return (
										<li key={option.label}>
											<button
												type="button"
												aria-pressed={isChosen}
												disabled={!canWrite}
												title={option.description || undefined}
												onClick={() => toggle(q, index, option.label)}
												className={cn(
													'inline-flex max-w-full items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 text-left text-[12.5px] font-semibold transition-colors disabled:opacity-50',
													isChosen
														? 'border-primary bg-primary text-primary-foreground'
														: 'border-border bg-card text-foreground hover:border-primary',
												)}
											>
												{isChosen ? <Check size={12} aria-hidden /> : null}
												<span className="truncate">{option.label}</span>
											</button>
										</li>
									)
								})}
							</ul>
						</ViewerTooltip>
						{q.multi_select ? (
							<p className="text-[10.5px] text-muted-foreground">Pick as many as apply</p>
						) : null}
					</fieldset>
				)
			})}
			<div className="flex flex-wrap items-center gap-2">
				<ViewerTooltip className="inline-flex items-center gap-2">
					<Button
						type="button"
						size="sm"
						onClick={submit}
						disabled={!allAnswered || isPending || !canWrite}
					>
						{isPending ? 'Sending…' : 'Send answer'}
					</Button>
					{/* Answering is optional — the agent is waiting on a turn, not blocked
					    on this widget, so typing a reply instead has to stay obviously
					    available rather than reading as a dead end. */}
					{typing ? null : (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="h-7 px-2 text-[11.5px] text-muted-foreground hover:text-foreground"
							onClick={() => setTyping(true)}
							disabled={!canWrite}
						>
							or type your reply
						</Button>
					)}
				</ViewerTooltip>
				{/* Read-only (opens the thread), so it stays usable for viewers. */}
				{trailingAction ? <div className="ml-auto">{trailingAction}</div> : null}
			</div>
			{typing ? (
				<div className="flex items-end gap-2">
					<Textarea
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter' && !e.shiftKey) {
								e.preventDefault()
								submitTyped()
							}
						}}
						placeholder="Type your reply…"
						rows={1}
						aria-label="Your reply"
						className="min-h-0 flex-1 resize-none"
					/>
					<Button
						type="button"
						size="sm"
						onClick={submitTyped}
						disabled={!typed.trim() || isPending}
					>
						Send
					</Button>
				</div>
			) : null}
			{isError ? (
				<p className="text-[10.5px] text-destructive">Couldn't send that. Try again.</p>
			) : null}
		</div>
	)
}
