import { Composer } from '@/components/chat/chat'
import { PageHeader } from '@/components/layout/page-header'
import { RouteError } from '@/components/shared/route-error'
import { useDefaultChatAgent } from '@/hooks/use-actors'
import { useCreateConversation } from '@/hooks/use-conversations'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { deriveConversationTitle } from '@/lib/conversation-title'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useCallback, useState } from 'react'

// Sentences that already carry everything a loop needs — a source it listens
// to and an end it reports to — so the first thing said is worth answering.
const EXAMPLE_SENTENCES = [
	'When a customer reports a bug in Slack, I want it triaged, fixed, and the customer told when the fix ships.',
	'Every trial that signs up should get to value in a week — and if they stall, I want someone to reach out.',
	'Chase every unpaid invoice for me — but never let a customer get a rude email.',
]

// The three primitives a loop is made of, in the order they get decided.
const PRIMER = [
	{ label: 'OBJECT TYPE', body: 'the thing that moves, and the states it moves through' },
	{ label: 'TRIGGER', body: 'watches one state, or one source, and hands the work on' },
	{ label: 'AGENT', body: 'does the actual work when a trigger fires' },
] as const

export const Route = createFileRoute('/_authed/$workspaceId/loops/new')({
	component: LoopBuilderPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

/**
 * New loop (mockup 2051–2130). There is no builder and no canvas: you describe
 * the loop in your own words, and that sentence opens a conversation with the
 * Chief of Staff — the workspace's boundary agent — who reads it back and
 * builds the loop with you. Nothing is created on this screen.
 */
function LoopBuilderPage() {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const createConversation = useCreateConversation(workspaceId)
	const chatAgent = useDefaultChatAgent()
	const [error, setError] = useState<string | null>(null)

	const handleSend = useCallback(
		async (content: string) => {
			setError(null)
			if (!chatAgent) {
				const message = 'No agent is available to build this loop yet.'
				setError(message)
				throw new Error(message)
			}
			try {
				const conversation = await createConversation.mutateAsync({
					title: deriveConversationTitle(content, 'New loop'),
					participant_actor_ids: [chatAgent.id],
					initial_message: content,
				})
				navigate({
					to: '/$workspaceId/chats/$conversationId',
					params: { workspaceId, conversationId: conversation.id },
				})
			} catch (err) {
				const message = err instanceof Error ? err.message : 'Failed to start the conversation'
				setError(message)
				throw err
			}
		},
		[chatAgent, createConversation, navigate, workspaceId],
	)

	return (
		<>
			{/* The breadcrumb (Loops › New loop) comes from the shared nav's routeConfig;
			    the mockup's right-aligned caption rides in the same row via `actions`. */}
			<PageHeader
				title="New loop"
				actions={
					<span className="hidden whitespace-nowrap text-[11px] text-muted-foreground lg:inline">
						no builder, no canvas — you describe it
					</span>
				}
			/>
			<div className="mx-auto flex w-full max-w-[760px] flex-col">
				<h1 className="text-2xl font-bold tracking-tight text-foreground md:text-[1.6875rem]">
					What should the loop do?
				</h1>
				<p className="mt-3 max-w-[48ch] text-sm leading-relaxed text-muted-foreground">
					Say it the way you'd say it to a colleague. Maskin picks the object types, writes the
					triggers on their states, and assigns agents from your crew. You read it back before
					anything exists.
				</p>

				<div className="mt-5 flex flex-col overflow-hidden rounded-xl border border-border">
					{PRIMER.map((row) => (
						<div
							key={row.label}
							className="flex items-baseline gap-2.5 border-b border-border bg-muted px-3.5 py-3 last:border-b-0"
						>
							<span className="eyebrow w-[86px] shrink-0">{row.label}</span>
							<span className="text-xs leading-relaxed text-muted-foreground">{row.body}</span>
						</div>
					))}
				</div>

				<div className="eyebrow mt-6">OR START FROM ONE OF THESE</div>
				<div className="mt-2.5 flex flex-col gap-2" aria-label="Example prompts">
					{EXAMPLE_SENTENCES.map((sentence) => (
						<button
							key={sentence}
							type="button"
							onClick={() => void handleSend(sentence)}
							className="rounded-xl border border-border bg-card px-3.5 py-3 text-left text-sm leading-relaxed text-foreground transition-colors hover:border-border-strong hover:bg-muted"
						>
							{sentence}
						</button>
					))}
				</div>

				<div className="mt-5">
					<Composer
						workspaceId={workspaceId}
						onSend={handleSend}
						disabled={false}
						pending={createConversation.isPending}
						surface="pulse-bar"
						placeholder="Describe what should happen, in your own words…"
						selection={EMPTY_CHAT_SELECTION}
						onRemoveAgent={() => {}}
						onRemoveObject={() => {}}
						onRemoveNotification={() => {}}
						onRemoveFile={() => {}}
						textareaLabel="Describe your loop"
					/>
					{error && (
						<p role="alert" className="mt-2 text-[11px] text-error">
							{error}
						</p>
					)}
				</div>
			</div>
		</>
	)
}
