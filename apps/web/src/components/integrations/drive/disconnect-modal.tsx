import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { type DriveDisconnectScope, remainingProviders } from '@/lib/drive-disconnect'
import { DRIVE_DISCONNECT_COPY as COPY } from '@/lib/drive-disconnect-copy'
import { X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

/** The Disconnect Drive modal: a native dialog (focus trap and Escape come from
 *  showModal), three radios in a radiogroup with Drive only preselected, a primary
 *  button whose label follows the radio and is announced politely, and a callout
 *  naming what stays connected. Mount it only while a human is selected; it opens
 *  on mount and the page unmounts it on close. */
export function DisconnectDriveModal({
	name,
	connected,
	pending,
	failed,
	onCancel,
	onConfirm,
}: {
	name: string
	/** The human's connected Google-family providers, from their live rows. */
	connected: readonly string[]
	pending: boolean
	failed: boolean
	onCancel: () => void
	onConfirm: (scope: DriveDisconnectScope) => void
}) {
	const dialogRef = useRef<HTMLDialogElement | null>(null)
	const [scope, setScope] = useState<DriveDisconnectScope>('drive')
	const titleId = useId()
	const bodyId = useId()
	const groupId = useId()

	useEffect(() => {
		const dialog = dialogRef.current
		if (dialog && !dialog.open) dialog.showModal()
	}, [])

	const options: { value: DriveDisconnectScope; label: string; hint: string; chip?: string }[] = [
		{
			value: 'drive',
			label: COPY.options.drive.label,
			hint: COPY.options.drive.hint(name),
		},
		{
			value: 'drive-meet',
			label: COPY.options['drive-meet'].label,
			hint: COPY.options['drive-meet'].hint,
			chip: COPY.options['drive-meet'].chip,
		},
		{
			value: 'google',
			label: COPY.options.google.label(name),
			hint: COPY.options.google.hint(name),
		},
	]

	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the native dialog cancel event (onCancel); the backdrop click is a pointer-only convenience on top of it
		<dialog
			ref={dialogRef}
			className="m-auto w-[min(28rem,92vw)] rounded-lg border border-border bg-card p-0 text-foreground backdrop:bg-black/50"
			aria-labelledby={titleId}
			aria-describedby={bodyId}
			// Escape fires cancel before close; hold it while the revoke is running.
			onCancel={(e) => {
				e.preventDefault()
				if (!pending) onCancel()
			}}
			// A click on the backdrop lands on the dialog element itself.
			onClick={(e) => {
				if (e.target === dialogRef.current && !pending) onCancel()
			}}
			data-testid="disconnect-drive-modal"
		>
			<div className="space-y-4 p-6">
				<div className="flex items-start justify-between gap-4">
					<h3 id={titleId} className="text-lg font-semibold text-foreground">
						{COPY.title(name)}
					</h3>
					<button
						type="button"
						onClick={onCancel}
						disabled={pending}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Close"
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
				<p id={bodyId} className="text-sm text-muted-foreground">
					{COPY.body(name, connected)}
				</p>
				<fieldset role="radiogroup" aria-labelledby={groupId} className="space-y-2">
					<legend id={groupId} className="sr-only">
						Choose how much to disconnect
					</legend>
					{options.map((option) => (
						<label
							key={option.value}
							className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg-surface p-3 has-[:checked]:border-primary"
						>
							<input
								type="radio"
								name="disconnect-drive-scope"
								value={option.value}
								checked={scope === option.value}
								onChange={() => setScope(option.value)}
								disabled={pending}
								className="mt-1"
							/>
							<span className="text-sm">
								<span className="block font-medium text-foreground">
									{option.label}
									{option.chip && (
										<span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
											{option.chip}
										</span>
									)}
								</span>
								<span className="block text-xs text-muted-foreground">{option.hint}</span>
							</span>
						</label>
					))}
				</fieldset>
				<div
					className="rounded-md border border-border bg-bg-surface p-3 text-xs text-muted-foreground"
					data-testid="disconnect-stays-callout"
				>
					{COPY.stays(remainingProviders(connected, scope))}
				</div>
				{failed && (
					<div role="alert">
						<FormError error={COPY.error} />
					</div>
				)}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onCancel} disabled={pending}>
						{COPY.cancel}
					</Button>
					<Button variant="destructive" onClick={() => onConfirm(scope)} disabled={pending}>
						{pending && <Spinner aria-hidden="true" />}
						<span aria-live="polite">{COPY.confirm[scope]}</span>
					</Button>
				</div>
			</div>
		</dialog>
	)
}
