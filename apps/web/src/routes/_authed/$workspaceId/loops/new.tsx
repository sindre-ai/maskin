import { Composer } from '@/components/chat/chat'
import { PageHeader } from '@/components/layout/page-header'
import { LoopPlanCard, draftFromPlan, mergeDraftOntoPlan } from '@/components/loops/loop-plan-card'
import { EmptyState } from '@/components/shared/empty-state'
import { RouteError } from '@/components/shared/route-error'
import { Card, CardContent } from '@/components/ui/card'
import { useCreateObject } from '@/hooks/use-objects'
import { trackLoopCreatedViaLanguage } from '@/lib/analytics'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { CornerDownLeft, Sparkles } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

const EXAMPLE_SENTENCES = [
	'Notify me weekly with a summary of new customer feedback, and triage anything at risk.',
	'Have a triage agent review every new feedback item when it comes in.',
	'Track bets and tell me before anything goes at risk or needs a rescue.',
]

export const Route = createFileRoute('/_authed/$workspaceId/loops/new')({
	component: LoopBuilderPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

interface ThreadItem {
	role: 'user' | 'plan'
	content: string
}

function LoopBuilderPage() {
	const { workspaceId } = useWorkspace()
	const createObject = useCreateObject(workspaceId)

	const [thread, setThread] = useState<ThreadItem[]>([])
	const [plan, setPlan] = useState<LoopPlan | null>(null)
	const [draft, setDraft] = useState(plan ? draftFromPlan(plan) : null)
	const [mode, setMode] = useState<'proposed' | 'editing'>('proposed')
	const [createdId, setCreatedId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	const applyDescription = useCallback((description: string) => {
		const parsed = parseLoopDescription(description)
		setPlan(parsed)
		setDraft(draftFromPlan(parsed))
		setMode('proposed')
		setCreatedId(null)
		setThread((prev) => [...prev, { role: 'user', content: description }])
	}, [])

	const handleSend = useCallback(
		async (content: string) => {
			applyDescription(content)
			setThread((prev) => [...prev, { role: 'plan', content: 'I drafted a loop from that.' }])
		},
		[applyDescription],
	)

	const resetAll = useCallback(() => {
		setPlan(null)
		setDraft(null)
		setMode('proposed')
		setCreatedId(null)
		setThread([])
	}, [])

	const handleCreate = useCallback(async () => {
		if (!plan || !draft || creating) return
		const merged = mergeDraftOntoPlan(plan, draft)
		const title = draft.name.trim() || `${merged.objectTypes[0]?.name ?? 'Loop'} loop`
		setCreating(true)
		try {
			const created = await createObject.mutateAsync({
				type: 'loop',
				title,
				status: 'running',
				// safeMetadataSchema only accepts primitives/arrays — store the plan
				// snapshot as a JSON string so the created loop carries the exact
				// preview (object types + state chain, triggers, agents, stop point).
				metadata: { plan: JSON.stringify(merged) },
			})
			setCreatedId(created.id)
			setMode('proposed')
			// Call site owned by T2: emit the accept event once per created loop so
			// the success metric (distinct accepting workspaces) is measurable.
			trackLoopCreatedViaLanguage({ workspace_id: workspaceId, loop_id: created.id })
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Failed to create loop')
		} finally {
			setCreating(false)
		}
	}, [plan, draft, creating, createObject, workspaceId])

	return (
		<div>
			<PageHeader title="Start a loop" />

			<div className="grid gap-6 md:grid-cols-2 items-start">
				{/* Left — conversation pane */}
				<section
					aria-label="Describe your loop"
					className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4"
				>
					<div className="flex items-center gap-2">
						<Sparkles size={16} className="text-accent-foreground" aria-hidden />
						<p className="text-sm text-foreground">
							Describe the loop you want to run in plain language.
						</p>
					</div>

					<div className="flex flex-wrap gap-2" aria-label="Example prompts">
						{EXAMPLE_SENTENCES.map((sentence) => (
							<button
								key={sentence}
								type="button"
								onClick={() => void handleSend(sentence)}
								className="inline-flex min-h-11 items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground hover:border-border-hover"
							>
								<CornerDownLeft size={13} className="shrink-0" aria-hidden />
								<span className="line-clamp-2">{sentence}</span>
							</button>
						))}
					</div>

					{thread.length > 0 && (
						<div className="flex flex-col gap-2 my-1">
							{thread.map((item, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript, order is stable
									key={i}
									className={cn(
										'rounded-md px-3 py-2 text-sm',
										item.role === 'user'
											? 'self-end bg-accent text-accent-foreground max-w-[85%]'
											: 'self-start bg-muted text-muted-foreground max-w-[85%]',
									)}
								>
									{item.content}
								</div>
							))}
						</div>
					)}

					<Composer
						workspaceId={workspaceId}
						onSend={handleSend}
						disabled={!!createdId}
						pending={false}
						surface="pulse-bar"
						placeholder="e.g. Notify me weekly with a summary of customer feedback…"
						selection={EMPTY_CHAT_SELECTION}
						onRemoveAgent={() => {}}
						onRemoveObject={() => {}}
						onRemoveNotification={() => {}}
						onRemoveFile={() => {}}
						textareaLabel="Describe your loop"
					/>
				</section>

				{/* Right — proposed loop / created */}
				<section aria-label="Proposed loop" className="min-w-0">
					{plan && draft ? (
						<LoopPlanCard
							plan={plan}
							draft={draft}
							mode={mode}
							workspaceId={workspaceId}
							onDraftChange={setDraft}
							onAdjust={() => setMode('editing')}
							onSave={() => setMode('proposed')}
							onCreate={() => void handleCreate()}
							onDone={resetAll}
							creating={creating}
							created={!!createdId}
							createdId={createdId}
						/>
					) : (
						<Card>
							<CardContent className="py-12">
								<EmptyState
									title="No loop drafted yet"
									description="Tap an example above, or type your own description. The proposed loop will appear here before anything is created."
								/>
							</CardContent>
						</Card>
					)}
				</section>
			</div>
		</div>
	)
}
