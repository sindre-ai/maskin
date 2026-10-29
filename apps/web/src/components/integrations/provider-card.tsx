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
	/** Extra lines under the subtitle, e.g. a price disclosure. */
	notes?: ReactNode
	/** Buttons / inputs on the right. */
	actions: ReactNode
	/** The tighter row used inside a chat message, with a subtitle that announces changes. */
	compact?: boolean
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
	notes,
	actions,
	compact = false,
	footer,
}: ProviderCardProps) {
	return (
		<div
			className={cn(
				'flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card',
				compact ? 'p-3' : 'p-4',
			)}
		>
			<div
				className={cn(
					'h-3 w-3 shrink-0 rounded-full',
					tone === 'warning' ? 'bg-warning' : tone === 'connected' ? 'bg-success' : 'bg-zinc-600',
				)}
			/>
			<div className="min-w-0 flex-1 basis-40">
				{badge ? (
					<div className="flex items-center gap-2">
						<p className="text-sm font-medium text-foreground truncate">{name}</p>
						{badge}
					</div>
				) : (
					<p className="text-sm font-medium text-foreground truncate">{name}</p>
				)}
				{subtitle && (
					<p
						className={cn(
							'text-xs truncate',
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
			{actions}
			{footer && <div className="basis-full">{footer}</div>}
		</div>
	)
}
