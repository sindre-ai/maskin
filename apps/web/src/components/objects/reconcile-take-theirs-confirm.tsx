import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'

interface ReconcileTakeTheirsConfirmProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	onConfirm: () => void
}

// The "take theirs" branch is destructive — a confirm step guards the
// overwrite of the user's dirty draft.
export function ReconcileTakeTheirsConfirm({
	open,
	onOpenChange,
	onConfirm,
}: ReconcileTakeTheirsConfirmProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-sm">
				<DialogHeader>
					<DialogTitle>Discard your edits?</DialogTitle>
					<DialogDescription>
						Taking theirs replaces the editor with the server's version. Your unsaved edits will be
						lost.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button variant="destructive" onClick={onConfirm}>
						Discard and take theirs
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
