/**
 * Generic affordance for an in-card mutation. Handles confirmation,
 * loading state, and inline error rendering on top of any callback.
 *
 * Usage stays narrow on purpose — the button delegates the actual
 * mutation to a parent-supplied `onRun`. Domain components like
 * `<StatusAction>` and `<OwnerAction>` wrap `useObjectMutation` and pass
 * their `run` to this button.
 */

import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { type ReactNode, useState } from 'react'
import { ConfirmDialog } from './confirm-dialog'
import { getMutationPolicy } from './policy'
import type { MutationKind, MutationOutcome } from './types'

export interface ActionButtonProps {
	kind: MutationKind
	/** Override the policy label (e.g. show the new status name). */
	label?: ReactNode
	/**
	 * Triggered after confirmation (or directly when policy.confirm is false).
	 * Returning a `MutationOutcome` is optional — fire-and-forget callbacks are
	 * also supported for cards that delegate the actual mutation upstream.
	 */
	// biome-ignore lint/suspicious/noConfusingVoidType: void/undefined union is the intended fire-and-forget contract
	onRun: () => Promise<MutationOutcome | void> | MutationOutcome | void
	disabled?: boolean
	className?: string
	/** Inline error shown beneath the button when the run rejected. */
	error?: string | null
	size?: 'sm' | 'default'
}

export function ActionButton({
	kind,
	label,
	onRun,
	disabled,
	className,
	error,
	size = 'sm',
}: ActionButtonProps) {
	const policy = getMutationPolicy(kind)
	const [open, setOpen] = useState(false)
	const [pending, setPending] = useState(false)

	const fire = async () => {
		setPending(true)
		try {
			await onRun()
		} finally {
			setPending(false)
			setOpen(false)
		}
	}

	const handleClick = () => {
		if (disabled || pending) return
		if (policy.confirm) setOpen(true)
		else void fire()
	}

	return (
		<div className={cn('inline-flex flex-col items-start gap-1', className)}>
			<Button
				type="button"
				variant={policy.variant === 'destructive' ? 'destructive' : 'outline'}
				size={size}
				onClick={handleClick}
				disabled={disabled || pending}
				aria-label={typeof label === 'string' ? label : policy.label}
			>
				{pending && <Spinner className="size-3" />}
				{label ?? policy.label}
			</Button>
			{error && <span className="text-[11px] text-destructive">{error}</span>}
			{policy.confirm && (
				<ConfirmDialog
					open={open}
					onOpenChange={(next) => {
						if (!pending) setOpen(next)
					}}
					title={policy.confirmTitle ?? policy.label}
					description={policy.confirmDescription}
					confirmLabel={policy.label}
					variant={policy.variant === 'destructive' ? 'destructive' : 'default'}
					pending={pending}
					onConfirm={() => void fire()}
				/>
			)}
		</div>
	)
}
