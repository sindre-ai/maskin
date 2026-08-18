import { Composer } from '@/components/chat/chat'
import { LoopPlanCard, draftFromPlan, mergeDraftOntoPlan } from '@/components/loops/loop-plan-card'
import { RouteError } from '@/components/shared/route-error'
import { useCreateObject } from '@/hooks/use-objects'
import { trackLoopCreatedViaLanguage } from '@/lib/analytics'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

const EXAMPLE_SENTENCES = [
	'Notify me weekly with a summary of new customer feedback, and triage anything at risk.',
	'Have a triage agent review every new feedback item when it comes in.',
	'Track bets and tell me before anything goes at risk or needs a rescue.',
]

const PRIMER = [
	{
		label: 'OBJECT TYPE',
		body: 'the thing that moves, and the states it moves through',
	},
	{
		label: 'TRIGGER',
		body: 'watches one state, or one source, and hands the work on',
	},
	{
		label: 'AGENT',
		body: 'does the actual work when a trigger fires',
	},
] as const

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
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3 md:px-6 lg:px-9">
				<Link
					to="/$workspaceId/loops"
					params={{ workspaceId }}
					className="text-xs text-muted-foreground hover:text-foreground"
				>
					Loops
				</Link>
				<span aria-hidden className="text-xs text-muted-foreground">
					›
				</span>
				<span className="text-xs font-semibold text-foreground">New loop</span>
				<span className="ml-auto whitespace-nowrap text-[11px] text-muted-foreground">
					no builder, no canvas — you describe it
				</span>
			</div>

			<div className="mx-auto flex w-full max-w-[1300px] flex-col gap-6 px-4 py-6 md:flex-row md:items-start md:gap-8 md:px-6 md:py-8 lg:px-9 xl:gap-11">
				{/* Left — conversation */}
				<section
					aria-label="Describe your loop"
					className="flex min-w-0 flex-1 flex-col md:basis-[340px]"
				>
					{plan === null ? (
						<>
							<h1 className="text-2xl font-bold tracking-tight text-foreground md:text-[1.6875rem]">
								What should the loop do?
							</h1>
							<p className="mt-3 max-w-prose text-sm leading-relaxed text-muted-foreground">
								Say it the way you'd say it to a colleague. Maskin picks the object types, writes
								the triggers on their states, and assigns agents from your crew. You read it back
								before anything exists.
							</p>

							<div className="mt-5 flex flex-col overflow-hidden rounded-xl border border-border">
								{PRIMER.map((row) => (
									<div
										key={row.label}
										className="flex items-baseline gap-2.5 border-b border-border bg-muted px-3.5 py-3 last:border-b-0"
									>
										<span className="eyebrow w-[86px] shrink-0">{row.label}</span>
										<span className="text-xs leading-relaxed text-muted-foreground">
											{row.body}
										</span>
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
						</>
					) : (
						<div className="flex items-center gap-2 text-xs text-muted-foreground">
							<Sparkles size={14} aria-hidden className="text-brand" />
							<span>Describing your loop — refine below.</span>
						</div>
					)}

					{thread.length > 0 && (
						<div className="mt-5 flex flex-col gap-3">
							{thread.map((item, i) => (
								<div
									// biome-ignore lint/suspicious/noArrayIndexKey: append-only transcript, order is stable
									key={i}
									className={cn(
										'flex flex-col gap-1',
										item.role === 'user' ? 'items-end' : 'items-start',
									)}
								>
									{item.role === 'user' ? (
										<>
											<div className="max-w-[90%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2.5 text-sm leading-relaxed text-primary-foreground">
												{item.content}
											</div>
											<span className="text-[10px] text-muted-foreground">you</span>
										</>
									) : (
										<div className="flex gap-2.5">
											<span
												aria-hidden
												className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-primary text-[11px] text-primary-foreground"
											>
												✦
											</span>
											<p className="min-w-0 flex-1 text-sm leading-relaxed text-foreground">
												{item.content}
											</p>
										</div>
									)}
								</div>
							))}
						</div>
					)}

					<div className="mt-5 pb-[env(safe-area-inset-bottom)] md:pb-0">
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
						<p className="mt-2 text-[11px] text-muted-foreground">
							Maskin only builds from language.
						</p>
					</div>
				</section>

				{/* Right — proposed loop / empty state */}
				<section
					aria-label="Proposed loop"
					className="flex min-w-0 flex-1 flex-col md:basis-[430px] md:grow-[1.1]"
				>
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
						<div
							aria-label="No loop drafted yet"
							className="flex flex-col gap-3.5 rounded-2xl border border-dashed border-border bg-muted p-6"
						>
							<p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
								The loop appears here as Maskin reads your sentence — object types first, then the
								triggers, then who answers them. Nothing is created until you say so.
							</p>
							<div className="flex flex-col gap-2" aria-hidden>
								<div className="h-12 rounded-lg bg-background" />
								<div className="h-16 rounded-lg bg-background" />
								<div className="h-16 rounded-lg bg-background/70" />
								<div className="h-12 rounded-lg border border-border bg-background" />
							</div>
						</div>
					)}
				</section>
			</div>
		</div>
	)
}
