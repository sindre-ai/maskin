import { Field } from '@/components/profile/_field'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useRequestEmailChange } from '@/hooks/use-auth'
import { trackEvent } from '@/lib/analytics'
import { ApiError } from '@/lib/api'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'

interface ChangeEmailDialogProps {
	actorId: string
	currentEmail: string | null
	presetEmail: string
	open: boolean
	onOpenChange: (open: boolean) => void
	onSuccess: () => void
}

export function ChangeEmailDialog(props: ChangeEmailDialogProps) {
	const { open, onOpenChange, presetEmail } = props
	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent>
				{/* Key the body so each open (and each Resend with a new preset
					email) starts with fresh useState initializers — no stale
					form data carried across opens, no useEffect reseed loop. */}
				<ChangeEmailDialogBody key={open ? `open-${presetEmail}` : 'closed'} {...props} />
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function ChangeEmailDialogBody({
	actorId,
	currentEmail,
	presetEmail,
	onOpenChange,
	onSuccess,
}: ChangeEmailDialogProps) {
	const mutation = useRequestEmailChange(actorId)
	const [newEmail, setNewEmail] = useState(presetEmail)
	const [password, setPassword] = useState('')
	const [touched, setTouched] = useState({ email: false, password: false })
	const [emailServerError, setEmailServerError] = useState<string | null>(null)
	const [passwordServerError, setPasswordServerError] = useState<string | null>(null)

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
		<form onSubmit={handleSubmit} className="contents">
			<ResponsiveDialogHeader>
				<ResponsiveDialogTitle>Change email</ResponsiveDialogTitle>
				<ResponsiveDialogDescription>
					We'll send a verification link to the new address. Your email won't change until you click
					it.
				</ResponsiveDialogDescription>
			</ResponsiveDialogHeader>

			<div className="flex flex-col gap-4 py-2">
				<Field
					id="new_email"
					label="New email"
					type="email"
					value={newEmail}
					onChange={(v) => {
						setNewEmail(v)
						if (emailServerError) setEmailServerError(null)
					}}
					onBlur={() => setTouched((t) => ({ ...t, email: true }))}
					error={emailServerError ?? emailError}
					autoComplete="email"
				/>
				<Field
					id="email_change_password"
					label="Current password"
					type="password"
					value={password}
					onChange={(v) => {
						setPassword(v)
						if (passwordServerError) setPasswordServerError(null)
					}}
					onBlur={() => setTouched((t) => ({ ...t, password: true }))}
					error={passwordServerError ?? passwordError}
					autoComplete="current-password"
				/>
			</div>

			<ResponsiveDialogFooter>
				<Button
					type="button"
					variant="outline"
					onClick={() => onOpenChange(false)}
					disabled={mutation.isPending}
				>
					Cancel
				</Button>
				<Button type="submit" disabled={!isValid || mutation.isPending}>
					{mutation.isPending ? 'Sending…' : 'Send verification email'}
				</Button>
			</ResponsiveDialogFooter>
		</form>
	)
}
