import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useInstallPackage } from '@/hooks/use-installed-packages'

interface InstallButtonProps {
	workspaceId: string
	packageId: string
	disabled?: boolean
}

export function InstallButton({ workspaceId, packageId, disabled }: InstallButtonProps) {
	const install = useInstallPackage(workspaceId)
	const isInstalling = install.isPending

	return (
		<Button
			size="sm"
			disabled={disabled || isInstalling}
			onClick={() => install.mutate({ packageId })}
		>
			{isInstalling ? (
				<>
					<Spinner className="h-3 w-3" />
					Installing…
				</>
			) : (
				'Install package'
			)}
		</Button>
	)
}
