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
	// Required for package uninstall; omit when providing onConfirm.
	installedPackageId?: string
	packageName: string
	isLocked: boolean
	// Override the internal package-uninstall mutation (e.g. for individual items).
	onConfirm?: (keepItems: boolean) => void
	confirmPending?: boolean
}

export function UninstallDialog({
	open,
	onOpenChange,
	workspaceId,
	installedPackageId,
	packageName,
	isLocked,
	onConfirm,
	confirmPending,
}: UninstallDialogProps) {
	const uninstall = useUninstallPackage(workspaceId)
	const [keepItems, setKeepItems] = useState(false)

	const isPending = onConfirm ? (confirmPending ?? false) : uninstall.isPending

	const handleConfirm = () => {
		if (onConfirm) {
			onConfirm(keepItems)
			return
		}
		if (!installedPackageId) return
		uninstall.mutate(
			{ installedPackageId, keepProvisionedItems: keepItems },
			{ onSuccess: () => onOpenChange(false) },
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Remove {packageName}?</DialogTitle>
					<DialogDescription>
						{isLocked
							? 'This package has provisioned agents, triggers, and skills in your workspace.'
							: 'This package has agents, triggers, and skills in your workspace.'}
					</DialogDescription>
				</DialogHeader>

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
								Deletes all agents, triggers, and skills from this package.
							</span>
						</Label>
					</div>
					<div className="flex items-start gap-3">
						<RadioGroupItem value="keep" id="keep-items" className="mt-0.5" />
						<Label htmlFor="keep-items" className="cursor-pointer font-normal leading-snug">
							<span className="font-medium">Keep agents, triggers, and skills</span>
							<br />
							<span className="text-xs text-muted-foreground">
								{isLocked
									? 'Components stay in your workspace as regular (unmanaged) resources.'
									: 'They remain in your workspace as regular resources.'}
							</span>
						</Label>
					</div>
				</RadioGroup>

				<DialogFooter className="gap-2">
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={handleConfirm} disabled={isPending}>
						{isPending ? (
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
