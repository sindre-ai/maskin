import { StatusPill, type StatusPillTone } from '@/components/integrations/drive/status-pill'
import { cn } from '@/lib/cn'
import type { ReactNode } from 'react'

export type ProviderCardTone = 'available' | 'connected' | 'warning'

interface ProviderCardProps {
	name: string
	/** Small label beside the name, e.g. a "New" pill. */
	badge?: ReactNode
	subtitle?: string
	/** `warning` colours both the dot and the subtitle; `connected` only the dot. */
	tone: ProviderCardTone
	/** Tooltip for the subtitle, e.g. the scopes a reconnect would grant. */
	subtitleTitle?: string
	/** The state pill on the Settings row ("Active", "Reconnect needed", "Online"). */
	status?: { tone: StatusPillTone; label: string }
	/** Extra lines under the subtitle, e.g. a price disclosure. */
	notes?: ReactNode
	/** Buttons / inputs on the right. */
	actions: ReactNode
	/** The tighter row used inside a chat message, with a subtitle that announces changes. */
	compact?: boolean
	/** The soft request-card look used inside a chat message. */
	chat?: boolean
	/** Full-width section under the row, e.g. which agents may use the integration. */
	footer?: ReactNode
}

/**
 * The provider row shared by Settings → Integrations and the Connect card an
 * agent puts in chat — same dot, name, subtitle and action slot in both places,
 * so a provider looks the same wherever it can be connected.
 */
export function ProviderCard({
	name,
	badge,
	subtitle,
	tone,
	subtitleTitle,
	status,
	notes,
	actions,
	compact = false,
	chat = false,
	footer,
}: ProviderCardProps) {
	// The Settings row is the v3 grouped card: no status dot, the state is a pill.
	// The chat card and the agent intro's quiet row keep the dot.
	const settingsRow = !chat && !compact
	return (
		<div
			className={cn(
				'flex flex-wrap items-center gap-3 border border-border',
				chat ? 'rounded-2xl bg-secondary px-4 py-3.5' : 'rounded-xl bg-card',
				!chat && (compact ? 'p-3' : 'px-4 py-3.5'),
			)}
		>
			{!settingsRow && (
				<div
					className={cn(
						'h-3 w-3 shrink-0 rounded-full',
						tone === 'warning'
							? 'bg-warning'
							: tone === 'connected'
								? 'bg-success'
								: 'bg-muted-foreground/40',
					)}
				/>
			)}
			<div className="min-w-0 flex-1 basis-40">
				{badge ? (
					<div className="flex items-center gap-2">
						<p
							className={cn(
								'truncate text-foreground',
								chat || settingsRow ? 'text-[15px] font-semibold' : 'text-sm font-medium',
							)}
						>
							{name}
						</p>
						{badge}
					</div>
				) : (
					<p
						className={cn(
							'truncate text-foreground',
							chat || settingsRow ? 'text-[15px] font-semibold' : 'text-sm font-medium',
						)}
					>
						{name}
					</p>
				)}
				{subtitle && (
					<p
						className={cn(
							'truncate',
							chat || settingsRow ? 'text-[13px]' : 'text-xs',
							tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
						)}
						title={subtitleTitle}
						aria-live={compact ? 'polite' : undefined}
					>
						{subtitle}
					</p>
				)}
				{notes}
			</div>
			{status && settingsRow && (
				<StatusPill soft tone={status.tone}>
					{status.label}
				</StatusPill>
			)}
			{actions}
			{footer && <div className="basis-full">{footer}</div>}
		</div>
	)
}
