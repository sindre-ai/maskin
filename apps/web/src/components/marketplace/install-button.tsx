import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInstallLoop } from '@/hooks/use-installed-loops'
import { cn } from '@/lib/cn'

interface InstallButtonProps {
	workspaceId: string
	loopId: string
	disabled?: boolean
	label?: string
	/** The catalogue row draws the action as an outline pill; the detail page keeps secondary. */
	variant?: 'secondary' | 'outline'
	className?: string
	/** Marketplace surface starting the install; only the detail view sets `'detail'`. */
	source?: 'detail'
}

export function InstallButton({
	workspaceId,
	loopId,
	disabled,
	label = 'Install',
	variant = 'secondary',
	className,
	source,
}: InstallButtonProps) {
	const install = useInstallLoop(workspaceId)
	const isInstalling = install.isPending

	return (
		<Button
			size="sm"
			variant={variant}
			className={cn('relative rounded-full font-semibold', className)}
			disabled={disabled || isInstalling}
			onClick={() => install.mutate({ loopId, source })}
		>
			{isInstalling ? (
				<>
					<Spinner className="h-3 w-3" />
					Installing…
				</>
			) : (
				label
			)}
		</Button>
	)
}
