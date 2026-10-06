import { Button } from '@/components/ui/button'
import { cn } from '@/lib/cn'
import { Check, Plus } from 'lucide-react'

export type ScopeState = 'granted' | 'missing'

/** One scope on one human: a tick when the token response carried it, a plus
 *  when it did not. The row announces as "<label>, granted|not granted". */
export function ScopeChip({
	label,
	sublabel,
	state,
}: {
	label: string
	sublabel: string
	state: ScopeState
}) {
	const granted = state === 'granted'
	return (
		<li
			className={cn(
				'flex items-start gap-2 rounded-md border p-2',
				granted ? 'border-success/30 bg-success/5' : 'border-warning/30 bg-warning/5 text-warning',
			)}
			aria-label={`${label}, ${granted ? 'granted' : 'not granted'}`}
			data-state={granted ? 'granted' : 'is-missing'}
		>
			<div
				className={cn(
					'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full',
					granted ? 'bg-success text-white' : 'bg-warning/20',
				)}
				aria-hidden="true"
			>
				{granted ? <Check className="h-3 w-3" /> : <Plus className="h-3 w-3" />}
			</div>
			<div className="min-w-0">
				<p className={cn('text-xs font-medium', granted ? 'text-foreground' : 'text-warning')}>
					{label}
				</p>
				<p className="font-mono text-[10px] text-muted-foreground">
					{granted ? sublabel : 'not granted'}
				</p>
			</div>
		</li>
	)
}

function initials(name: string): string {
	return name
		.split(/[\s@.]+/)
		.filter(Boolean)
		.map((part) => part[0]?.toUpperCase())
		.slice(0, 2)
		.join('')
}

/** A human with their Google identity and per-scope status. The scope chips are
 *  children so a provider can pass one chip per scope it asks for. */
export function ScopeRow({
	id,
	name,
	email,
	needsAttention,
	statusLine,
	actionLabel,
	onAction,
	actionPending,
	disconnectLabel,
	onDisconnect,
	children,
}: {
	id: string
	name: string
	email: string
	needsAttention: boolean
	/** Muted line under the identity, e.g. "No Drive reads yet". */
	statusLine?: string
	actionLabel?: string
	onAction?: () => void
	actionPending?: boolean
	/** Secondary action that opens the disconnect flow for this human. */
	disconnectLabel?: string
	onDisconnect?: () => void
	children: React.ReactNode
}) {
	return (
		<li
			className={cn(
				'rounded-md border p-3',
				needsAttention ? 'border-warning/40 bg-warning/5' : 'border-border bg-bg-surface',
			)}
			data-testid={`scope-row-${id}`}
			data-state={needsAttention ? 'is-missing' : 'is-complete'}
		>
			<div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
				<div className="flex min-w-0 items-center gap-3">
					<div
						className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-foreground"
						aria-hidden="true"
					>
						{initials(name)}
					</div>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium text-foreground">{name}</p>
						<p className="truncate text-xs text-muted-foreground">{email}</p>
						{statusLine && <p className="text-xs text-muted-foreground">{statusLine}</p>}
					</div>
				</div>
				<div className="flex shrink-0 flex-wrap gap-2">
					{actionLabel && onAction && (
						<Button size="sm" variant="outline" onClick={onAction} disabled={actionPending}>
							{actionLabel}
						</Button>
					)}
					{disconnectLabel && onDisconnect && (
						<Button size="sm" variant="ghost" onClick={onDisconnect}>
							{disconnectLabel}
						</Button>
					)}
				</div>
			</div>
			<ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">{children}</ul>
		</li>
	)
}
