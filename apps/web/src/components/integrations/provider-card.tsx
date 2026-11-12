import type { StatusPillTone } from '@/components/integrations/drive/status-pill'
import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'
import { type ReactNode, useState } from 'react'

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
	/** The logo tile. Passing it draws the v3 integration card: logo, dot, name, a short
	 *  access `chip`, and a chevron that opens the actions and footer. */
	logo?: ReactNode
	chip?: string
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
	logo,
	chip,
}: ProviderCardProps) {
	const [open, setOpen] = useState(false)
	if (logo) {
		const expandable = tone !== 'available'
		const dot = tone === 'warning' ? 'bg-warning' : tone === 'connected' ? 'bg-success' : undefined
		const header = (
			<>
				{logo}
				{dot && <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', dot)} />}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<p className="truncate text-base font-semibold text-foreground">{name}</p>
						{badge}
					</div>
					{subtitle && !expandable && (
						<p className="truncate text-[13px] text-muted-foreground">{subtitle}</p>
					)}
					{!expandable && notes}
				</div>
				{chip && (
					<span className="shrink-0 rounded-full bg-muted px-3 py-1 text-[13px] font-semibold text-muted-foreground max-sm:hidden">
						{chip}
					</span>
				)}
			</>
		)
		return (
			<div className="rounded-2xl border border-border bg-card">
				{expandable ? (
					<button
						type="button"
						onClick={() => setOpen((v) => !v)}
						aria-expanded={open}
						className="flex w-full items-center gap-3 rounded-2xl p-[18px] text-left transition-colors hover:bg-bg-hover"
					>
						{header}
						<ChevronDown
							aria-hidden="true"
							className={cn(
								'size-4 shrink-0 text-muted-foreground transition-transform',
								open && 'rotate-180',
							)}
						/>
					</button>
				) : (
					<div className="flex flex-wrap items-center gap-3 p-[18px]">
						{header}
						{actions}
					</div>
				)}
				{expandable && open && (
					<div className="space-y-3 border-t border-border-subtle px-[18px] pt-3 pb-4">
						{subtitle && (
							<p
								className={cn(
									'text-[13px]',
									tone === 'warning' ? 'text-warning' : 'text-muted-foreground',
								)}
								title={subtitleTitle}
							>
								{subtitle}
							</p>
						)}
						{notes}
						<div className="flex flex-wrap items-center gap-2">{actions}</div>
						{footer}
					</div>
				)}
			</div>
		)
	}
	// The Settings row is the v3 grouped card: no status dot, the state is a pill.
	// The chat card and the agent intro's quiet row keep the dot.
	const settingsRow = !chat && !compact
	return (
		<div
			className={cn(
				'flex flex-wrap items-center gap-3',
				settingsRow && 'border-b border-border-subtle px-2 py-3.5',
				!settingsRow && 'border border-border',
				chat ? 'rounded-2xl bg-secondary px-4 py-3.5' : !settingsRow && 'rounded-xl bg-card',
				!chat && compact && 'p-3',
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
				<span
					className={cn(
						'shrink-0 text-[13px] font-medium',
						status.tone === 'ok' ? 'text-success' : 'text-warning',
					)}
					aria-label={status.label}
				>
					{status.label}
				</span>
			)}
			{actions}
			{footer && <div className="basis-full">{footer}</div>}
		</div>
	)
}
