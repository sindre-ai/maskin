import { type LifecyclePhase, phaseCopy } from './phase-map'

/**
 * Static, non-interactive phase divider (D10, v11 states section 3).
 *
 * Renders `{glyph} {LABEL}` centred between two hairlines. It sits at the
 * phase-boundary crossing and reads as a chapter heading — the reader is not
 * meant to collapse it, so there is no toggle button here (the
 * collapsible-per-phase treatment is a legacy of the ObjectActivity surface,
 * deliberately dropped in v4 TimelineTab).
 */
export function PhaseDivider({ phase }: { phase: LifecyclePhase }) {
	const { glyph, label } = phaseCopy(phase)
	return (
		// biome-ignore lint/a11y/useSemanticElements: <hr> can't host the labelled caption + hairline layout; ARIA separator role is fine here per SPEC.
		// biome-ignore lint/a11y/useFocusableInteractive: the divider is decorative — the label is a static chapter heading, not a stop for keyboard traversal.
		<div
			role="separator"
			aria-label={`${label} phase`}
			className="relative z-[2] flex items-center gap-3 bg-background pb-1.5 pt-3"
		>
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
			<span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
				<span aria-hidden="true">{glyph}</span>
				<span>{label}</span>
			</span>
			<span aria-hidden="true" className="h-px flex-1 bg-border" />
		</div>
	)
}
