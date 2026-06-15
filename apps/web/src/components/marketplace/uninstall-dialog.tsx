import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Spinner } from '@/components/ui/spinner'
import { useUninstallPackage } from '@/hooks/use-installed-packages'
import { useState } from 'react'

interface UninstallDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	installedPackageId: string
	packageName: string
	isLocked: boolean
}

export function UninstallDialog({
	open,
	onOpenChange,
	workspaceId,
	installedPackageId,
	packageName,
	isLocked,
}: UninstallDialogProps) {
	const uninstall = useUninstallPackage(workspaceId)
	const [keepItems, setKeepItems] = useState(false)

	const handleConfirm = () => {
		uninstall.mutate(
			{ installedPackageId, keepProvisionedItems: keepItems },
			{ onSuccess: () => onOpenChange(false) },
		)
	}

	const hasComponents = isLocked

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Remove {packageName}?</DialogTitle>
					<DialogDescription>
						{hasComponents
							? 'This package has provisioned agents, triggers, and skills in your workspace.'
							: 'This will remove the package tracking record from your workspace.'}
					</DialogDescription>
				</DialogHeader>

				{hasComponents && (
					<RadioGroup
						value={keepItems ? 'keep' : 'remove'}
						onValueChange={(v) => setKeepItems(v === 'keep')}
						className="space-y-3"
					>
						<div className="flex items-start gap-3">
							<RadioGroupItem value="remove" id="remove-all" className="mt-0.5" />
							<Label htmlFor="remove-all" className="cursor-pointer font-normal leading-snug">
								<span className="font-medium">Remove everything</span>
								<br />
								<span className="text-xs text-muted-foreground">
									Deletes all agents, triggers, and skills provisioned by this package.
								</span>
							</Label>
						</div>
						<div className="flex items-start gap-3">
							<RadioGroupItem value="keep" id="keep-items" className="mt-0.5" />
							<Label htmlFor="keep-items" className="cursor-pointer font-normal leading-snug">
								<span className="font-medium">Keep agents, triggers, and skills</span>
								<br />
								<span className="text-xs text-muted-foreground">
									Components stay in your workspace as regular (unmanaged) resources.
								</span>
							</Label>
						</div>
					</RadioGroup>
				)}

				<DialogFooter className="gap-2">
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={uninstall.isPending}
					>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleConfirm} disabled={uninstall.isPending}>
						{uninstall.isPending ? (
							<>
								<Spinner className="h-3 w-3" />
								Removing…
							</>
						) : (
							'Remove'
						)}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
