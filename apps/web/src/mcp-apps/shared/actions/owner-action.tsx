/**
 * In-card owner mutator. v1 keeps the affordance minimal — the user
 * pastes / picks an actor UUID and presses "Assign". A full actor picker
 * lives in F7's Actors card; here we only need the round-trip primitive
 * so cards expose ownership changes without bouncing to the web app.
 *
 * Ownership clears via the trailing "Clear" button which sends `null`.
 */

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/cn'
import { type FormEvent, useState } from 'react'
import { useObjectMutation } from './use-object-mutation'

export interface OwnerActionProps {
	objectId: string
	currentOwner: string | null
	workspaceId?: string
	disabled?: boolean
	className?: string
	/** Optional callback fired after the server confirms the change. */
	onSuccess?: (next: string | null) => void
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function OwnerAction({
	objectId,
	currentOwner,
	workspaceId,
	disabled,
	className,
	onSuccess,
}: OwnerActionProps) {
	const mutation = useObjectMutation<string | null>({
		objectId,
		field: 'owner',
		workspaceId,
		onSuccess,
	})
	const value = mutation.optimisticValue ?? currentOwner
	const [draft, setDraft] = useState(value ?? '')
	const [validation, setValidation] = useState<string | null>(null)

	const submit = (e: FormEvent) => {
		e.preventDefault()
		const trimmed = draft.trim()
		if (trimmed.length === 0) {
			void mutation.run(null)
			return
		}
		if (!UUID_RE.test(trimmed)) {
			setValidation('Owner must be a UUID. Use list_actors to find one.')
			return
		}
		setValidation(null)
		void mutation.run(trimmed)
	}

	const clear = () => {
		setDraft('')
		setValidation(null)
		void mutation.run(null)
	}

	const error = validation ?? mutation.error

	return (
		<form className={cn('inline-flex flex-col items-start gap-1', className)} onSubmit={submit}>
			<div className="flex items-center gap-2">
				<Input
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					placeholder="actor uuid"
					disabled={disabled || mutation.isPending}
					aria-label="Owner actor ID"
					className="h-8 w-56 text-xs"
				/>
				<Button type="submit" size="sm" variant="outline" disabled={disabled || mutation.isPending}>
					{mutation.isPending ? 'Saving…' : 'Assign'}
				</Button>
				{value && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						onClick={clear}
						disabled={disabled || mutation.isPending}
					>
						Clear
					</Button>
				)}
			</div>
			{error && (
				<span className="text-[11px] text-destructive" role="alert">
					{error}
				</span>
			)}
		</form>
	)
}
