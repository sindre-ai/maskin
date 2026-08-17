import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInstallLoop } from '@/hooks/use-installed-loops'

interface InstallButtonProps {
	workspaceId: string
	loopId: string
	disabled?: boolean
	label?: string
	/** Marketplace surface starting the install; only the detail view sets `'detail'`. */
	source?: 'detail'
}

export function InstallButton({
	workspaceId,
	loopId,
	disabled,
	label = 'Install loop',
	source,
}: InstallButtonProps) {
	const install = useInstallLoop(workspaceId)
	const isInstalling = install.isPending

	return (
		<Button
			size="sm"
			className="relative"
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
