import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useCancelEmailChange, useRequestEmailChange } from '@/hooks/use-auth'
import { trackEvent } from '@/lib/analytics'
import { type ActorResponse, ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AlertTriangle } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { toast } from 'sonner'

interface ChangeEmailDialogProps {
	actorId: string
	currentEmail: string | null
	presetEmail: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onSuccess: () => void
}

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
				<VerificationBanner
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

function VerificationBanner({
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

function ChangeEmailDialog({
	actorId,
	currentEmail,
	presetEmail,
	open,
	onOpenChange,
	onSuccess,
}: ChangeEmailDialogProps) {
	const mutation = useRequestEmailChange(actorId)
	const mutationReset = mutation.reset
	const [newEmail, setNewEmail] = useState('')
	const [password, setPassword] = useState('')
	const [touched, setTouched] = useState({ email: false, password: false })
	const [emailServerError, setEmailServerError] = useState<string | null>(null)
	const [passwordServerError, setPasswordServerError] = useState<string | null>(null)

	// Seed (or reseed) the dialog state every time it opens. Parents toggle
	// `open` directly when they want the Resend flow to pre-fill the new email,
	// so `useState` initializers — which only run once — wouldn't pick that up.
	useEffect(() => {
		if (!open) return
		setNewEmail(presetEmail)
		setPassword('')
		setTouched({ email: false, password: false })
		setEmailServerError(null)
		setPasswordServerError(null)
		mutationReset()
	}, [open, presetEmail, mutationReset])

	function reset() {
		setNewEmail('')
		setPassword('')
		setTouched({ email: false, password: false })
		setEmailServerError(null)
		setPasswordServerError(null)
		mutationReset()
	}

	function handleOpenChange(value: boolean) {
		if (!value) reset()
		onOpenChange(value)
	}

	const trimmedEmail = newEmail.trim()
	const sameAsCurrent = !!currentEmail && trimmedEmail.toLowerCase() === currentEmail.toLowerCase()
	// Loose email shape — server runs the authoritative Zod email check; this
	// gates the disabled state only.
	const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)
	const emailError = touched.email
		? trimmedEmail.length === 0
			? 'Enter a new email address.'
			: !looksLikeEmail
				? "That doesn't look like a valid email."
				: sameAsCurrent
					? 'New email matches your current address.'
					: null
		: null
	const passwordError = touched.password && password.length === 0 ? 'Enter your password.' : null

	const isValid = looksLikeEmail && !sameAsCurrent && password.length > 0

	async function handleSubmit(e: FormEvent) {
		e.preventDefault()
		setTouched({ email: true, password: true })
		if (!isValid) return

		setEmailServerError(null)
		setPasswordServerError(null)
		try {
			await mutation.mutateAsync({
				new_email: trimmedEmail,
				current_password: password,
			})
			trackEvent('profile.field_changed', { field: 'pending_email' })
			toast.success('Verification email sent')
			onSuccess()
			reset()
		} catch (err) {
			if (err instanceof ApiError) {
				if (err.status === 401) {
					setPasswordServerError('Current password is incorrect.')
					return
				}
				if (err.status === 409) {
					setEmailServerError('That address is already in use.')
					return
				}
			}
			setEmailServerError(err instanceof Error ? err.message : 'Could not request email change.')
		}
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
			<ResponsiveDialogContent>
				<form onSubmit={handleSubmit} className="contents">
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>Change email</ResponsiveDialogTitle>
						<ResponsiveDialogDescription>
							We'll send a verification link to the new address. Your email won't change until you
							click it.
						</ResponsiveDialogDescription>
					</ResponsiveDialogHeader>

					<div className="flex flex-col gap-4 py-2">
						<div className="flex flex-col gap-1">
							<Label htmlFor="new_email">New email</Label>
							<Input
								id="new_email"
								type="email"
								value={newEmail}
								onChange={(e) => {
									setNewEmail(e.target.value)
									if (emailServerError) setEmailServerError(null)
								}}
								onBlur={() => setTouched((t) => ({ ...t, email: true }))}
								autoComplete="email"
								aria-invalid={emailServerError || emailError ? true : undefined}
								className={cn((emailServerError || emailError) && 'border-destructive')}
							/>
							{(emailServerError ?? emailError) ? (
								<span className="text-xs text-destructive">{emailServerError ?? emailError}</span>
							) : null}
						</div>

						<div className="flex flex-col gap-1">
							<Label htmlFor="email_change_password">Current password</Label>
							<Input
								id="email_change_password"
								type="password"
								value={password}
								onChange={(e) => {
									setPassword(e.target.value)
									if (passwordServerError) setPasswordServerError(null)
								}}
								onBlur={() => setTouched((t) => ({ ...t, password: true }))}
								autoComplete="current-password"
								aria-invalid={passwordServerError || passwordError ? true : undefined}
								className={cn((passwordServerError || passwordError) && 'border-destructive')}
							/>
							{(passwordServerError ?? passwordError) ? (
								<span className="text-xs text-destructive">
									{passwordServerError ?? passwordError}
								</span>
							) : null}
						</div>
					</div>

					<ResponsiveDialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={mutation.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!isValid || mutation.isPending}>
							{mutation.isPending ? 'Sending…' : 'Send verification email'}
						</Button>
					</ResponsiveDialogFooter>
				</form>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
