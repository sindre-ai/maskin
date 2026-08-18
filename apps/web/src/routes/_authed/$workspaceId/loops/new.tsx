import { Composer } from '@/components/chat/chat'
import { PageHeader } from '@/components/layout/page-header'
import { LoopPlanCard, draftFromPlan, mergeDraftOntoPlan } from '@/components/loops/loop-plan-card'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { useCreateObject } from '@/hooks/use-objects'
import { trackLoopCreatedViaLanguage } from '@/lib/analytics'
import { EMPTY_CHAT_SELECTION } from '@/lib/chat-selection'
import { cn } from '@/lib/cn'
import { type LoopPlan, parseLoopDescription } from '@/lib/loop-plan'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

const EXAMPLE_SENTENCES = [
	'Notify me weekly with a summary of new customer feedback, and triage anything at risk.',
	'Have a triage agent review every new feedback item when it comes in.',
	'Track bets and tell me before anything goes at risk or needs a rescue.',
]

// Clarify state (mockup 2094–2106). A sentence with no `when` clause and no
// stop point can't be drawn as a loop — these chips name the two things that
// are missing and append the clause so the parser can re-read the sentence.
const FILL_IN_CHIPS = [
	{ label: '…when it comes in', clause: 'when it comes in' },
	{ label: '…when it changes status', clause: 'when it changes status' },
	{ label: '…and ask me before it goes out', clause: 'and ask me before it goes out' },
]

// Refine chips (mockup 2119–2125) — offered once a plan exists, so the next
// utterance is still language rather than a form.
const REFINE_CHIPS = [
	{ label: 'Add a weekly summary', clause: 'and send me a weekly summary' },
	{ label: 'Ask me before it publishes', clause: 'and ask me before it publishes' },
	{ label: 'Notify me when it closes', clause: 'and notify me when it closes' },
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
	const { workspaceId, workspace } = useWorkspace()
	const createObject = useCreateObject(workspaceId)

	// The workspace's own per-type status vocabulary — both the state chain the
	// plan proposes and the `NEW TYPE` signal are derived from it.
	const statusChains = useMemo(
		() => (workspace.settings as { statuses?: Record<string, string[]> } | undefined)?.statuses,
		[workspace.settings],
	)

	const [thread, setThread] = useState<ThreadItem[]>([])
	const [utterance, setUtterance] = useState('')
	const [plan, setPlan] = useState<LoopPlan | null>(null)
	const [draft, setDraft] = useState(plan ? draftFromPlan(plan) : null)
	const [mode, setMode] = useState<'proposed' | 'editing'>('proposed')
	const [createdId, setCreatedId] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)

	const applyDescription = useCallback(
		(description: string) => {
			const parsed = parseLoopDescription(description, { statusChains })
			setUtterance(description)
			setPlan(parsed)
			setDraft(draftFromPlan(parsed))
			setMode('proposed')
			setCreatedId(null)
			setThread((prev) => [...prev, { role: 'user', content: description }])
		},
		[statusChains],
	)

	const handleSend = useCallback(
		async (content: string) => {
			applyDescription(content)
			setThread((prev) => [...prev, { role: 'plan', content: 'I drafted a loop from that.' }])
		},
		[applyDescription],
	)

	// Chips extend the sentence the operator already said rather than replacing
	// it — the loop is still built from one continuous piece of language.
	const extendUtterance = useCallback(
		(clause: string) => {
			const base = utterance.trim().replace(/[.!?]+$/, '')
			void handleSend(base ? `${base} ${clause}.` : `${clause}.`)
		},
		[utterance, handleSend],
	)

	const resetAll = useCallback(() => {
		setPlan(null)
		setDraft(null)
		setUtterance('')
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

	// A sentence Maskin can't draw: it named no source it listens to and no end
	// it reports to, so there is nothing to wire between (mockup 2094–2106).
	const needsClarifying = plan !== null && plan.triggers.length === 0 && !plan.stopForOperator
	const showBlueprint = plan !== null && draft !== null && !needsClarifying
	const asking = plan === null

	// What Maskin actually did with the sentence (mockup 2108–2117). Derived
	// from the plan, so it never claims a step the parser didn't take.
	const steps = useMemo(() => {
		if (!plan) return []
		const done: string[] = ['Read your sentence']
		if (plan.objectTypes.length > 0) {
			done.push(`Picked ${plan.objectTypes.map((t) => t.name).join(' and ')}`)
		}
		if (plan.triggers.length > 0) {
			done.push(`Wrote ${plan.triggers.length} trigger${plan.triggers.length === 1 ? '' : 's'}`)
		}
		if (plan.agents.length > 0) {
			done.push(`Assigned ${plan.agents.map((a) => a.name).join(' and ')}`)
		}
		if (plan.stopForOperator) done.push('Marked where it stops for you')
		return done
	}, [plan])

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
			<div className="mx-auto flex w-full max-w-[1300px] flex-col gap-6 md:flex-row md:items-start md:gap-8 xl:gap-11">
				{/* Left — conversation */}
				<section
					aria-label="Describe your loop"
					className="flex min-w-0 flex-1 flex-col md:sticky md:top-0 md:basis-[340px] md:self-start"
				>
					{asking ? (
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

					{needsClarifying && (
						<>
							<div className="mt-4 flex flex-wrap gap-2" aria-label="Fill in what is missing">
								{FILL_IN_CHIPS.map((chip) => (
									<Button
										key={chip.clause}
										size="sm"
										variant="outline"
										className="rounded-full border-foreground"
										onClick={() => extendUtterance(chip.clause)}
									>
										{chip.label}
									</Button>
								))}
							</div>
							<div className="eyebrow mt-5">OR START FROM ONE OF THESE</div>
							<div className="mt-2.5 flex flex-col gap-2" aria-label="Example prompts">
								{EXAMPLE_SENTENCES.map((sentence) => (
									<button
										key={sentence}
										type="button"
										onClick={() => void handleSend(sentence)}
										className="rounded-xl border border-border bg-card px-3.5 py-3 text-left text-[12.5px] leading-relaxed text-foreground transition-colors hover:border-border-strong hover:bg-muted"
									>
										{sentence}
									</button>
								))}
							</div>
						</>
					)}

					{steps.length > 0 && !needsClarifying && (
						<ul className="mt-4 flex flex-col gap-2 border-l-2 border-border pl-3.5">
							{steps.map((step) => (
								<li
									key={step}
									className="flex items-baseline gap-2.5 text-[12.5px] leading-snug text-muted-foreground"
								>
									<span aria-hidden className="shrink-0 text-[11px] text-success">
										✓
									</span>
									{step}
								</li>
							))}
						</ul>
					)}

					{showBlueprint && !createdId && (
						<div className="mt-4 flex flex-wrap gap-2" aria-label="Refine this loop">
							{REFINE_CHIPS.map((chip) => (
								<Button
									key={chip.clause}
									size="sm"
									variant="outline"
									className="rounded-full"
									onClick={() => extendUtterance(chip.clause)}
								>
									{chip.label}
								</Button>
							))}
						</div>
					)}

					<div className="mt-5">
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
					{showBlueprint && draft ? (
						<LoopPlanCard
							plan={plan}
							draft={draft}
							mode={mode}
							workspaceId={workspaceId}
							onDraftChange={setDraft}
							onAdjust={() => setMode('editing')}
							onSave={() => setMode('proposed')}
							onCreate={() => void handleCreate()}
							onStartOver={resetAll}
							creating={creating}
							created={!!createdId}
							createdId={createdId}
						/>
					) : needsClarifying ? (
						<div
							aria-label="Nothing to draw yet"
							className="max-w-[46ch] rounded-2xl border border-dashed border-border bg-muted px-5 py-6 text-xs leading-relaxed text-muted-foreground"
						>
							Nothing to draw yet. A loop needs a source it listens to and an end it reports to —
							name both and the blueprint fills in.
						</div>
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
		</>
	)
}
