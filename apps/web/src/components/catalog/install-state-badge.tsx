import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/cn'

export type InstallState =
	| { kind: 'managed'; version: string }
	| { kind: 'forked'; version: string }

export function InstallStateBadge({
	state,
	className,
}: {
	state: InstallState
	className?: string
}) {
	if (state.kind === 'managed') {
		return (
			<Badge
				variant="outline"
				className={cn('gap-1 border-border bg-muted text-muted-foreground font-medium', className)}
			>
				<span aria-hidden>🔒</span>
				Managed · v{state.version}
			</Badge>
		)
	}
	return (
		<Badge
			variant="outline"
			className={cn(
				'gap-1 border-violet-200 bg-violet-100 text-violet-800 font-medium',
				'dark:border-violet-900 dark:bg-violet-950 dark:text-violet-200',
				className,
			)}
		>
			<span aria-hidden>⑂</span>
			Forked from v{state.version}
		</Badge>
	)
}
