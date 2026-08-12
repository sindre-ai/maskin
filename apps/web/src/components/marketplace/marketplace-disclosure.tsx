import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { OperatorAsk } from '@/lib/marketplace-asks'

/** Sectioning pieces for the marketplace detail surfaces. Each section is
 * presentational: the loop/item detail pages derive the rows from the real
 * item snapshots and hand completed lists in. Sections stay generic so they
 * can be reused verbatim by the loop and item pages. */

function SectionTitle({ title, subtitle }: { title: string; subtitle?: string }) {
	return (
		<div className="mb-3 flex items-center gap-2">
			<h2 className="text-sm font-semibold text-foreground">{title}</h2>
			{subtitle ? <span className="text-xs text-muted-foreground">{subtitle}</span> : null}
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

/** Numbered step rows for "The flow" — one per trigger, showing which agent
 * acts, when, what it does, and an "asks you" pill when that agent's prompt
 * hands control back to the operator. */
export function FlowSection({ steps }: { steps: FlowStep[] }) {
	if (steps.length === 0) return null

	return (
		<div>
			<SectionTitle title="The flow" subtitle="what happens, in order, after you install" />
			<ol className="flex flex-col gap-2">
				{steps.map((step) => (
					<li key={step.num}>
						<FlowStepRow step={step} />
					</li>
				))}
			</ol>
		</div>
	)
}

function FlowStepRow({ step }: { step: FlowStep }) {
	return (
		<div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
			<span className="mt-0.5 w-5 shrink-0 text-center font-mono text-xs font-medium text-muted-foreground tabular-nums">
				{step.num}
			</span>
			<ActorAvatar
				id={step.agentId || step.agentName}
				name={step.agentName}
				type={step.agentType}
				className="mt-0.5 shrink-0"
			/>
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
					<span className="text-sm font-medium text-foreground">{step.agentName}</span>
					{step.when && <span className="text-xs text-muted-foreground">{step.when}</span>}
				</div>
				{step.what ? (
					<p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{step.what}</p>
				) : null}
				{step.ask ? (
					<span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-accent-foreground">
						<span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
						asks you · {step.ask.ask}
					</span>
				) : null}
			</div>
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

/** "What it will ask you for" — one row per gated step, naming the ask, when
 * it happens, and the source reason pulled verbatim from the agent prompt. */
export function AsksSection({ rows }: { rows: AskRow[] }) {
	if (rows.length === 0) return null

	return (
		<div>
			<SectionTitle title="What it will ask you for" subtitle="where control returns to you" />
			<div className="flex flex-col gap-2">
				{rows.map((row) => (
					<div key={row.id} className="rounded-lg border border-border bg-background px-4 py-3">
						<div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
							<span className="text-sm font-medium text-foreground">{row.agentName}</span>
							<span className="text-xs text-accent">{row.ask}</span>
							{row.when ? (
								<span className="text-xs text-muted-foreground">when {row.when}</span>
							) : null}
						</div>
						{row.why ? (
							<p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">{row.why}</p>
						) : null}
					</div>
				))}
			</div>
		</div>
	)
}

export interface KvRow {
	label: string
	value: string
}

/** Key/value disclosure block ("How it runs", "Permissions"). Keys sit on
 * their own line below `sm` (mobile), beside the value from `sm` up. */
function KvSection({ title, subtitle, rows }: { title: string; subtitle?: string; rows: KvRow[] }) {
	if (rows.length === 0) return null

	return (
		<div>
			<SectionTitle title={title} subtitle={subtitle} />
			<div className="flex flex-col gap-px overflow-hidden rounded-lg border border-border bg-background p-4">
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
 * snapshot fields the detail page resolves. */
export function RunsSection({ rows }: { rows: KvRow[] }) {
	return <KvSection title="How it runs" rows={rows} />
}

/** "Permissions" — mono key/value rows derived from the loop's real actor
 * surfaces plus the product-level scope every marketplace install is bound to. */
export function PermissionsSection({ rows }: { rows: KvRow[] }) {
	return <KvSection title="Permissions" rows={rows} />
}
