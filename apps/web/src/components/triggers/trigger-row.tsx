import { RelativeTime } from '@/components/shared/relative-time'
import type { TriggerResponse } from '@/lib/api'
import { Link } from '@tanstack/react-router'
import { Bell, Clock, Zap } from 'lucide-react'

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
		const expr = String(config.expression ?? '')
		return `Runs on schedule: ${expr}`
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

export function TriggerRow({
	trigger,
	workspaceId,
	agentName,
}: {
	trigger: TriggerResponse
	workspaceId: string
	agentName: string
}) {
	const Icon = TRIGGER_TYPE_ICON[trigger.type] ?? Zap
	const description = describeTrigger(trigger)

	return (
		<Link
			to="/$workspaceId/triggers/$triggerId"
			params={{ workspaceId, triggerId: trigger.id }}
			className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 hover:bg-accent/50 transition-colors"
		>
			<div className="flex flex-col items-center gap-1">
				<span
					className={`h-3 w-3 rounded-full shrink-0 ${trigger.enabled ? 'bg-success' : 'bg-zinc-600'}`}
				/>
			</div>
			<Icon size={15} className="shrink-0 text-muted-foreground" />
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-sm font-medium text-foreground truncate">{trigger.name}</p>
					{!trigger.enabled && (
						<span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
							Disabled
						</span>
					)}
				</div>
				<p className="text-xs text-muted-foreground truncate">{description}</p>
				<p className="text-xs text-muted-foreground/60 mt-0.5">
					Agent: {agentName}
					{trigger.updatedAt && (
						<>
							{' · '}Updated <RelativeTime date={trigger.updatedAt} />
						</>
					)}
				</p>
			</div>
		</Link>
	)
}
