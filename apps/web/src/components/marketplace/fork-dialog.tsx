import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Spinner } from '@/components/ui/spinner'
import { useForkInstalledLoop } from '@/hooks/use-installed-loops'

interface ForkDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	installedLoopId: string
	loopName: string
	installedVersion: string
	pendingVersion?: string | null
}

export function ForkDialog({
	open,
	onOpenChange,
	workspaceId,
	installedLoopId,
	loopName,
	installedVersion,
	pendingVersion,
}: ForkDialogProps) {
	const fork = useForkInstalledLoop(workspaceId)
	const isForking = fork.isPending
	const hasPending = Boolean(pendingVersion && pendingVersion !== installedVersion)

	const body = hasPending
		? `You'll get an independent copy of ${loopName} at v${installedVersion}. v${pendingVersion} is ready to install — fork now and you skip it. Future updates appear as a banner, but won't be pushed.`
		: `You'll get an independent copy of ${loopName} at v${installedVersion}. Future updates from Maskin will appear as a banner, but won't be pushed to a fork.`

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Fork this loop?</DialogTitle>
					<DialogDescription>{body}</DialogDescription>
				</DialogHeader>
				<p className="text-sm text-muted-foreground">Forking can't be undone.</p>
				<DialogFooter className="gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isForking}>
						Cancel
					</Button>
					<Button
						onClick={() =>
							fork.mutate({ installedLoopId }, { onSuccess: () => onOpenChange(false) })
						}
						disabled={isForking}
					>
						{isForking ? (
							<>
								<Spinner className="h-3 w-3" />
								Forking…
							</>
						) : (
							'Fork'
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
