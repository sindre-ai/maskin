import type { LoopSummary } from '@/lib/api'

export const LOOP_PILL_STYLES: Record<
	LoopSummary['pill'],
	{ label: string; dot: string; text: string }
> = {
	draft: { label: 'Draft', dot: 'bg-zinc-400', text: 'text-muted-foreground' },
	paused: { label: 'Paused', dot: 'bg-zinc-500', text: 'text-muted-foreground' },
	learning: { label: 'Learning', dot: 'bg-primary', text: 'text-foreground' },
	supervised: { label: 'Supervised', dot: 'bg-primary', text: 'text-foreground' },
	fully_autonomous: { label: 'Fully autonomous', dot: 'bg-success', text: 'text-success' },
	waiting_on_you: { label: 'Waiting on you', dot: 'bg-warning', text: 'text-warning' },
}
