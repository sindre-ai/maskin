import { type LifecyclePhase, phaseCopy } from './phase-map'

/**
 * Static, non-interactive phase divider (mockup 1226–1233, D10).
 *
 * Renders `{glyph} {LABEL}` inside a compact pill on the timeline rail. The
 * pill sits at the phase-boundary crossing and reads as a chapter heading —
 * the reader is not meant to collapse it, so there is no toggle button here
 * (the collapsible-per-phase treatment is a legacy of the ObjectActivity
 * surface, deliberately dropped in v4 TimelineTab).
 */
export function PhaseDivider({ phase }: { phase: LifecyclePhase }) {
	const { glyph, label } = phaseCopy(phase)
	return (
		// biome-ignore lint/a11y/useSemanticElements: <hr> can't host the labelled pill + hairline layout; ARIA separator role is fine here per SPEC.
		// biome-ignore lint/a11y/useFocusableInteractive: the divider is decorative — the pill is a static chapter heading, not a stop for keyboard traversal.
		<div
			role="separator"
			aria-label={`${label} phase`}
			className="relative z-[2] flex items-center gap-2.5 bg-background pb-1.5 pt-3"
		>
			<span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-[3px] font-mono text-[9.5px] font-bold uppercase tracking-[0.11em] text-muted-foreground">
				<span aria-hidden="true">{glyph}</span>
				<span>{label}</span>
			</span>
			<span aria-hidden="true" className="h-px flex-1 bg-muted" />
		</div>
	)
}
