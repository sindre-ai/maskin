import type { LoopSummary } from '@/lib/api'

export const LOOP_PILL_STYLES: Record<
	LoopSummary['pill'],
	{ label: string; dot: string; text: string }
> = {
	running: { label: 'Running', dot: 'bg-success', text: 'text-success' },
	waiting_on_you: { label: 'Waiting on you', dot: 'bg-warning', text: 'text-warning' },
	paused: { label: 'Paused', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
	archived: { label: 'Archived', dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}
