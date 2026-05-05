/**
 * Confirmation dialog used by `<ActionButton>` for destructive mutations.
 * Mirrors the project's shadcn/ui Dialog primitive — no custom styling, just
 * a thin wrapper that wires the confirm/cancel callbacks.
 */

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
import type { ReactNode } from 'react'

export interface ConfirmDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	title: string
	description?: ReactNode
	confirmLabel?: string
	cancelLabel?: string
	variant?: 'default' | 'destructive'
	pending?: boolean
	onConfirm: () => void
}

export function ConfirmDialog({
	open,
	onOpenChange,
	title,
	description,
	confirmLabel = 'Confirm',
	cancelLabel = 'Cancel',
	variant = 'default',
	pending = false,
	onConfirm,
}: ConfirmDialogProps) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description && <DialogDescription>{description}</DialogDescription>}
				</DialogHeader>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						{cancelLabel}
					</Button>
					<Button type="button" variant={variant} onClick={onConfirm} disabled={pending}>
						{pending && <Spinner className="size-3" />}
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
