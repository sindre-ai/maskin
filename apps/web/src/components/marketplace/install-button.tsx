import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInstallLoop } from '@/hooks/use-installed-loops'

interface InstallButtonProps {
	workspaceId: string
	loopId: string
	disabled?: boolean
	label?: string
}

export function InstallButton({
	workspaceId,
	loopId,
	disabled,
	label = 'Install loop',
}: InstallButtonProps) {
	const install = useInstallLoop(workspaceId)
	const isInstalling = install.isPending

	return (
		<Button
			size="sm"
			disabled={disabled || isInstalling}
			onClick={() => install.mutate({ loopId })}
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
