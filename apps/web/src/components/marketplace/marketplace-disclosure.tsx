import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { OperatorAsk } from '@/lib/marketplace-asks'

/** Sectioning pieces for the marketplace detail surfaces. Each section is
 * presentational: the loop/item detail pages derive the rows from the real
 * item snapshots and hand completed lists in. Sections stay generic so they
 * can be reused verbatim by the loop and item pages. */

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
	return (
		<div className="mb-3 flex items-center gap-2.5">
			<h2 className="shrink-0 text-sm font-bold text-foreground">{title}</h2>
			{subtitle ? (
				<span className="min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>
			) : null}
			{/* The mockup's hairline rule that runs out to the column edge (2640). */}
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
		</div>
	)
}

export interface FlowStep {
	num: number
	agentName: string
	agentType: string
	agentId: string
	when: string
	what: string
	ask: OperatorAsk | null
}

/** Numbered step rows for the flow — one per trigger, showing which agent acts,
 * when, what it does, and an "asks you" pill when that agent's prompt hands
 * control back to the operator. The steps sit on a single card threaded by a
 * vertical rail (mockup 2642–2674). */
export function FlowSection({
	steps,
	title = 'The flow',
	subtitle,
}: {
	steps: FlowStep[]
	/** "The loop, once installed" for a bundle, "How it works" for one item. */
	title?: string
	subtitle?: string
}) {
	if (steps.length === 0) return null

	return (
		<div>
			<SectionTitle title={title} subtitle={subtitle} />
			<ol className="rounded-2xl border border-border bg-card px-3 py-1 md:px-[18px]">
				{steps.map((step) => (
					<li key={step.num} className="flex gap-3.5">
						<span className="relative flex w-[22px] shrink-0 justify-center">
							<span aria-hidden="true" className="absolute inset-y-0 left-[11px] w-px bg-border" />
							{/* `bg-primary`, never `bg-accent` — a text-free indicator on
							    `bg-accent` is near-invisible in light mode. */}
							<span
								aria-hidden="true"
								className="relative mt-[15px] size-[11px] shrink-0 rounded-full bg-primary ring-[3px] ring-card"
							/>
						</span>
						<div className="min-w-0 flex-1 py-2.5">
							<FlowStepRow step={step} />
						</div>
					</li>
				))}
			</ol>
		</div>
	)
}

function FlowStepRow({ step }: { step: FlowStep }) {
	return (
		<div className="flex items-start gap-2.5 rounded-xl border border-border bg-background px-3 py-2.5">
			<span className="mt-px grid size-5 shrink-0 place-items-center rounded-md bg-muted font-mono text-[9.5px] font-bold text-muted-foreground tabular-nums">
				{step.num}
			</span>
			<ActorAvatar
				id={step.agentId || step.agentName}
				name={step.agentName}
				type={step.agentType}
				className="mt-px size-[22px] shrink-0 text-[8.5px]"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="text-[12.5px] font-bold text-foreground">{step.agentName}</span>
					{step.when && <span className="text-[12.5px] text-muted-foreground">{step.when}</span>}
				</div>
				{step.what ? (
					<p className="mt-1 line-clamp-2 text-[11.5px] leading-normal text-muted-foreground">
						{step.what}
					</p>
				) : null}
			</div>
			{step.ask ? (
				<span className="shrink-0 rounded-full border border-status-processing-text/30 bg-status-processing-bg px-2 py-0.5 text-[10.5px] font-bold text-status-processing-text">
					asks you · {step.ask.ask}
				</span>
			) : null}
		</div>
	)
}

export interface AskRow {
	id: string
	agentName: string
	when: string
	ask: string
	why: string
}

/** "What it will ask you for" — one row per gated step on the parchment ask
 * surface (mockup 2692–2697), naming the ask, who asks and when, and the
 * source reason pulled verbatim from the agent prompt. */
export function AsksSection({ rows, note }: { rows: AskRow[]; note?: string }) {
	if (rows.length === 0) return null

	return (
		<div>
			<SectionTitle title="What it will ask you for" subtitle="the only places it stops for you" />
			<div className="flex flex-col gap-[7px]">
				{rows.map((row) => (
					<div
						key={row.id}
						className="flex items-start gap-3 rounded-xl border border-ask-border bg-ask-surface px-3.5 py-2.5"
					>
						<span
							aria-hidden="true"
							className="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-status-processing-bg text-[9.5px] font-bold text-status-processing-text"
						>
							?
						</span>
						<div className="min-w-0 flex-1">
							<span className="block text-[12.5px] font-semibold text-foreground">{row.ask}</span>
							<span className="mt-0.5 block text-[11.5px] text-muted-foreground">
								{row.agentName}
								{row.when ? `, when ${row.when}` : ''}
							</span>
							{row.why ? (
								<p className="mt-1 line-clamp-2 text-[11.5px] text-muted-foreground">{row.why}</p>
							) : null}
						</div>
					</div>
				))}
				{note ? <p className="px-0.5 pt-1 text-[11.5px] text-muted-foreground">{note}</p> : null}
			</div>
		</div>
	)
}

export interface KvRow {
	label: string
	value: string
}

/** Key/value disclosure block ("How it runs"). Keys sit on their own line
 * below `sm` (mobile), beside the value from `sm` up. */
function KvSection({ title, subtitle, rows }: { title: string; subtitle?: string; rows: KvRow[] }) {
	if (rows.length === 0) return null

	return (
		<div>
			<SectionTitle title={title} subtitle={subtitle} />
			<div className="flex flex-col gap-px overflow-hidden rounded-xl border border-border bg-background p-4">
				{rows.map((row) => (
					<div key={row.label} className="flex flex-col gap-0.5 py-1.5 sm:flex-row sm:gap-3">
						<span className="w-32 shrink-0 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
							{row.label}
						</span>
						<span className="min-w-0 flex-1 text-sm break-words text-foreground">{row.value}</span>
					</div>
				))}
			</div>
		</div>
	)
}

/** "How it runs" — version / runtime / model / triggers, all from the loop
 * snapshot fields the detail page resolves. Kept as real facts rather than the
 * mockup's placeholder prose, which stands in for data it did not have. */
export function RunsSection({ rows, subtitle }: { rows: KvRow[]; subtitle?: string }) {
	return <KvSection title="How it runs" subtitle={subtitle} rows={rows} />
}

/** "Permissions" — a wrapping row of pills (mockup 2708–2711), each carrying
 * one real permission value derived from the loop's actor surfaces plus the
 * product-level scope every marketplace install is bound to. */
export function PermissionsSection({ pills }: { pills: string[] }) {
	if (pills.length === 0) return null

	return (
		<div>
			<SectionTitle title="Permissions" />
			<div className="flex flex-wrap gap-1.5">
				{pills.map((pill) => (
					<span
						key={pill}
						className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-foreground"
					>
						{pill}
					</span>
				))}
			</div>
		</div>
	)
}
