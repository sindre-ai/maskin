import { Button } from '@/components/ui/button'
import { useSendMessage } from '@/hooks/use-conversation'
import type { MessageQuestion, MessageQuestionItem } from '@/lib/api'
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
}: QuestionOptionsProps) {
	// question index -> chosen labels. Deliberately NOT keyed by header: nothing
	// makes headers unique (the schema validates each one independently, and the
	// hook defaults every unheadered question to the literal "Question"), so two
	// colliding headers would share one state entry — one click selecting both
	// questions, and `allAnswered` passing on a single pick. The header is still
	// what goes back out in the answer payload; it is just not an identity.
	const [picked, setPicked] = useState<Record<number, string[]>>({})
	const sendMessage = useSendMessage(conversationId, workspaceId)

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

	const submit = () => {
		if (!allAnswered || sendMessage.isPending) return
		// The content is what the agent actually reads, so it repeats the question
		// alongside the pick — the agent's next turn arrives without the chip UI's
		// context, and "API token" alone would be ambiguous across two questions.
		const content = question.questions
			.map((q, i) => `**${q.header}** — ${q.question}\n${(picked[i] ?? []).join(', ')}`)
			.join('\n\n')
		sendMessage.mutate({
			content,
			metadata: { question_answer: { question_message_id: questionMessageId, answers } },
		})
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
						<ul className="flex list-none flex-wrap gap-1.5 p-0">
							{q.options.map((option) => {
								const isChosen = chosen.includes(option.label)
								return (
									<li key={option.label}>
										<button
											type="button"
											aria-pressed={isChosen}
											title={option.description || undefined}
											onClick={() => toggle(q, index, option.label)}
											className={cn(
												'inline-flex max-w-full items-center gap-1.5 rounded-[9px] border px-2.5 py-1.5 text-left text-[12.5px] font-semibold transition-colors',
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
						{q.multi_select ? (
							<p className="text-[10.5px] text-muted-foreground">Pick as many as apply</p>
						) : null}
					</fieldset>
				)
			})}
			<div className="flex items-center gap-2">
				<Button
					type="button"
					size="sm"
					onClick={submit}
					disabled={!allAnswered || sendMessage.isPending}
				>
					{sendMessage.isPending ? 'Sending…' : 'Send answer'}
				</Button>
				{/* Answering is optional — the agent is waiting on a turn, not blocked
				    on this widget, so typing a reply instead has to stay obviously
				    available rather than reading as a dead end. */}
				<span className="text-[10.5px] text-muted-foreground">or just type your reply</span>
			</div>
			{sendMessage.isError ? (
				<p className="text-[10.5px] text-destructive">Couldn't send that. Try again.</p>
			) : null}
		</div>
	)
}
