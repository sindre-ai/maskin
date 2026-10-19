import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'

/**
 * Structural placeholder for the bulk grant modal (design spec A draws it only
 * as "multi-select agents + a single tool-set grant"). Not wired: nothing here
 * writes a grant, and the primary action is disabled.
 */
export function BulkGrantDialog({
	open,
	onOpenChange,
	extensionName,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	extensionName: string
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Bulk grant → {extensionName}</DialogTitle>
					<DialogDescription>
						Pick several agents and one set of tools to give all of them at once.
					</DialogDescription>
				</DialogHeader>
				<p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
					Not available yet. Grant agents one at a time from the Agent access list.
				</p>
				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled>Grant</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
