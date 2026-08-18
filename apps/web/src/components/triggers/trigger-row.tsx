import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Switch } from '@/components/ui/switch'
import type { TriggerResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { describeCronExpression } from '@/lib/cron'
import { Link } from '@tanstack/react-router'
import { Bell, ChevronRight, Clock, Zap } from 'lucide-react'

export function describeTrigger(trigger: Pick<TriggerResponse, 'type' | 'config'>): string {
	const config = trigger.config ?? {}
	if (trigger.type === 'event') {
		const entity = String(config.entity_type ?? 'object')
		const action = String(config.action ?? 'modified')
		if (action === 'status_changed') {
			const from = config.from_status ? String(config.from_status) : 'any'
			const to = config.to_status ? String(config.to_status) : 'any'
			return `When ${entity} changes from ${from} to ${to}`
		}
		return `When ${entity} is ${action}`
	}
	if (trigger.type === 'cron') {
		const expr = config.expression ? String(config.expression) : ''
		return expr ? `Runs ${describeCronExpression(expr)}` : 'Runs on a schedule'
	}
	if (trigger.type === 'reminder') {
		const at = config.scheduled_at ? new Date(String(config.scheduled_at)) : null
		if (at)
			return `Fires on ${at.toLocaleDateString()} at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
		return 'One-time reminder'
	}
	return trigger.type
}

const TRIGGER_TYPE_ICON: Record<string, typeof Zap> = {
	event: Zap,
	cron: Clock,
	reminder: Bell,
}

// The 34px glyph tile (mockup 1547) — one tint per trigger kind, always a
// semantic pair so both modes stay legible.
const TRIGGER_TYPE_TILE: Record<string, string> = {
	event: 'bg-brand-subtle text-brand-subtle-foreground',
	cron: 'bg-secondary text-secondary-foreground',
	reminder: 'bg-muted text-muted-foreground',
}

export function TriggerRow({
	trigger,
	workspaceId,
	agentName,
	agentId,
	agentType = 'agent',
	onToggleEnabled,
	isToggling,
}: {
	trigger: TriggerResponse
	workspaceId: string
	agentName: string
	agentId?: string
	agentType?: string
	/** Wire to flip the trigger on/off inline. Omitted (e.g. read-only surfaces)
	 *  hides the switch rather than rendering a dead control. */
	onToggleEnabled?: (next: boolean) => void
	isToggling?: boolean
}) {
	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
	const description = describeTrigger(trigger)

	return (
		// The row is a link *and* carries an inline switch. Nesting a button in an
		// anchor is invalid and would navigate on toggle, so the link is a full-row
		// overlay underneath pointer-transparent content, and only the switch opts
		// pointer events back in.
		<div className="group relative flex items-center gap-3.5 rounded-xl border border-border px-4 py-3.5 transition-colors duration-150 hover:border-border-strong">
			<Link
				to="/$workspaceId/triggers/$triggerId"
				params={{ workspaceId, triggerId: trigger.id }}
				className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span className="sr-only">Open {trigger.name}</span>
			</Link>

			<span
				aria-hidden="true"
				className={cn(
					'pointer-events-none relative grid size-[34px] shrink-0 place-items-center rounded-[10px]',
					TRIGGER_TYPE_TILE[trigger.type] ?? TRIGGER_TYPE_TILE.event,
				)}
			>
				<Icon size={16} />
			</span>

			<div className="pointer-events-none relative min-w-0 flex-1 leading-[1.4]">
				<p className="truncate text-[13px] font-bold text-foreground">{trigger.name}</p>
				<p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">{description}</p>
			</div>

			<div className="pointer-events-none relative hidden shrink-0 items-center gap-1.5 md:flex">
				<ActorAvatar id={agentId} name={agentName} type={agentType} />
				<span className="text-[11.5px] text-muted-foreground">{agentName}</span>
			</div>

			<span
				className={cn(
					'pointer-events-none relative w-6 shrink-0 text-right text-[11px] font-semibold',
					trigger.enabled ? 'text-success' : 'text-muted-foreground',
				)}
			>
				{trigger.enabled ? 'On' : 'Off'}
			</span>

			{onToggleEnabled && (
				<span className="relative shrink-0">
					<Switch
						checked={trigger.enabled}
						disabled={isToggling}
						onCheckedChange={(next) => onToggleEnabled(next)}
						aria-label={`${trigger.enabled ? 'Disable' : 'Enable'} ${trigger.name}`}
					/>
				</span>
			)}

			<ChevronRight
				size={15}
				aria-hidden="true"
				className="pointer-events-none relative shrink-0 text-muted-foreground"
			/>
		</div>
	)
}
