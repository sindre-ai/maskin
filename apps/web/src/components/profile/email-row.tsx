import { ChangeEmailDialog } from '@/components/profile/change-email-dialog'
import { EmailVerificationBanner } from '@/components/profile/email-verification-banner'
import { Button } from '@/components/ui/button'
import type { ActorResponse } from '@/lib/api'
import { useState } from 'react'

export function EmailRow({ actor }: { actor: ActorResponse }) {
	const [dialogOpen, setDialogOpen] = useState(false)
	// Resend reuses the same dialog with the new email pre-filled. The user
	// re-enters their current password (the backend has no resend endpoint
	// that bypasses it), and on submit we mint a fresh token.
	const [presetEmail, setPresetEmail] = useState('')

	function openFresh() {
		setPresetEmail('')
		setDialogOpen(true)
	}

	function openForResend(pending: string) {
		setPresetEmail(pending)
		setDialogOpen(true)
	}

	return (
		<>
			<div
				data-row="email"
				className="grid grid-cols-1 gap-1 py-3.5 md:grid-cols-[160px_1fr] md:items-center md:gap-4"
			>
				<div className="pt-1 text-sm font-medium text-muted-foreground">Email</div>
				<div className="flex items-center justify-between gap-4">
					<span className="truncate text-sm text-foreground">{actor.email ?? '—'}</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={openFresh}
						aria-label="Change email"
					>
						Change
					</Button>
				</div>
			</div>
			{actor.pending_email ? (
				<EmailVerificationBanner
					actorId={actor.id}
					pendingEmail={actor.pending_email}
					onResend={() => openForResend(actor.pending_email ?? '')}
				/>
			) : null}
			<ChangeEmailDialog
				actorId={actor.id}
				currentEmail={actor.email}
				presetEmail={presetEmail}
				open={dialogOpen}
				onOpenChange={setDialogOpen}
				onSuccess={() => setDialogOpen(false)}
			/>
		</>
	)
}
