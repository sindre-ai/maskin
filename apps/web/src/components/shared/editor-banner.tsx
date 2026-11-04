import { cn } from '@/lib/cn'
import { AlertTriangle, Info } from 'lucide-react'
import type { ReactNode } from 'react'

export interface EditorBannerProps {
	/**
	 * info: the muted one-line notice (read-only). danger: a problem the person
	 * has to act on (save failed, file changed under them).
	 */
	tone: 'info' | 'danger'
	/** Optional bold heading above the message. */
	heading?: string
	children: ReactNode
	/** Buttons or links on the right (below the text on narrow screens). */
	actions?: ReactNode
	/** info is announced politely (status), danger interrupts (alert). */
	className?: string
}

/**
 * The banner slot above an editor document: the read-only line, the
 * save-failed banner and the file-changed (conflict) banner share it so they
 * look and announce the same way everywhere the editor is mounted.
 */
export function EditorBanner({ tone, heading, children, actions, className }: EditorBannerProps) {
	const Icon = tone === 'danger' ? AlertTriangle : Info
	return (
		<div
			role={tone === 'danger' ? 'alert' : 'status'}
			className={cn(
				'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-sm',
				tone === 'danger'
					? 'border-destructive/40 bg-destructive/10 text-foreground'
					: 'border-border bg-muted text-muted-foreground',
				className,
			)}
		>
			<Icon
				size={14}
				className={cn('shrink-0', tone === 'danger' ? 'text-destructive' : undefined)}
				aria-hidden="true"
			/>
			<div className="min-w-0 flex-1 basis-64">
				{heading && <p className="font-medium text-foreground">{heading}</p>}
				<p>{children}</p>
			</div>
			{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
		</div>
	)
}
