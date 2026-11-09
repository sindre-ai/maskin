import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'

export interface SuggestedTarget {
	key: string
	title: string
	optionLabel: string
}

interface TakeSuggestedDialogProps {
	targets: readonly SuggestedTarget[]
	/** Cards left out because their suggested option sends a message. */
	leftOut: number
	onConfirm: () => void
	onCancel: () => void
}

/**
 * The step before "Take every suggested option" posts anything: what will be
 * answered, card by card, so a bulk tap is never a blind one. Options that send
 * a message are not part of the bulk path; those are approved on the card, where
 * the recipient is visible.
 */
export function TakeSuggestedDialog({
	targets,
	leftOut,
	onConfirm,
	onCancel,
}: TakeSuggestedDialogProps) {
	return (
		<ResponsiveDialog open onOpenChange={(open) => !open && onCancel()}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Take every suggested option?</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						{targets.length === 1 ? '1 card gets' : `${targets.length} cards get`} the answer the
						agent suggested.
						{leftOut > 0
							? ` ${leftOut === 1 ? '1 card that would send' : `${leftOut} cards that would send`} a message ${leftOut === 1 ? 'is' : 'are'} left out: approve ${leftOut === 1 ? 'it' : 'those'} on the card.`
							: ''}
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				<ul className="flex max-h-64 flex-col gap-2 overflow-y-auto text-[13px]">
					{targets.map((target) => (
						<li key={target.key} className="flex flex-col">
							<span className="text-foreground">{target.title}</span>
							<span className="text-muted-foreground">{target.optionLabel}</span>
						</li>
					))}
				</ul>
				<ResponsiveDialogFooter>
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button onClick={onConfirm}>
						{targets.length === 1 ? 'Answer 1 card' : `Answer ${targets.length} cards`}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
