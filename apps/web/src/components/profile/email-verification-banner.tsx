import { Button } from '@/components/ui/button'
import { useCancelEmailChange } from '@/hooks/use-auth'
import { AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'

export function EmailVerificationBanner({
	actorId,
	pendingEmail,
	onResend,
}: {
	actorId: string
	pendingEmail: string
	onResend: () => void
}) {
	const cancelMutation = useCancelEmailChange(actorId)

	async function handleCancel() {
		try {
			await cancelMutation.mutateAsync()
			toast.success('Email change cancelled')
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not cancel email change')
		}
	}

	return (
		<div
			data-row="email-verification"
			aria-live="polite"
			className="flex flex-col gap-3 bg-warning/10 px-3 py-3 text-sm sm:flex-row sm:items-start sm:gap-4 sm:px-4"
		>
			<AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
			<div className="flex-1">
				<p className="font-medium text-foreground">Verify your new email address</p>
				<p className="mt-0.5 text-muted-foreground">
					We sent a verification link to <span className="font-medium">{pendingEmail}</span>. Click
					it to finish the change.
				</p>
			</div>
			<div className="flex shrink-0 gap-2">
				<Button
					type="button"
					variant="outline"
					size="sm"
					onClick={onResend}
					aria-label="Resend verification email"
				>
					Resend
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={handleCancel}
					disabled={cancelMutation.isPending}
					aria-label="Cancel email change"
				>
					{cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
				</Button>
			</div>
		</div>
	)
}
