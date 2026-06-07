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
import { useChangePassword } from '@/hooks/use-auth'
import { trackEvent } from '@/lib/analytics'
import { ApiError } from '@/lib/api'
import { type FormEvent, useState } from 'react'
import { toast } from 'sonner'

const MIN_LENGTH = 8

interface Errors {
	current_password?: string
	new_password?: string
	confirm_password?: string
}

function validate(
	current: string,
	next: string,
	confirm: string,
	touched: { current: boolean; next: boolean; confirm: boolean },
): Errors {
	const errors: Errors = {}
	if (touched.current && current.length === 0) {
		errors.current_password = 'Enter your current password.'
	}
	if (touched.next && next.length < MIN_LENGTH) {
		errors.new_password = `New password must be at least ${MIN_LENGTH} characters.`
	}
	if (touched.confirm && confirm !== next) {
		errors.confirm_password = "Passwords don't match."
	}
	return errors
}

export function PasswordRow() {
	const [open, setOpen] = useState(false)

	return (
		<div
			data-row="password"
			className="grid grid-cols-1 gap-1 py-3.5 md:grid-cols-[160px_1fr] md:items-center md:gap-4"
		>
			<div className="pt-1 text-sm font-medium text-muted-foreground">Password</div>
			<div className="flex flex-col gap-1">
				<div className="flex items-center justify-between gap-4">
					<span className="text-sm text-muted-foreground">••••••••</span>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => setOpen(true)}
						aria-label="Change password"
					>
						Change
					</Button>
				</div>
			</div>
			<PasswordDialog open={open} onOpenChange={setOpen} />
		</div>
	)
}

function PasswordDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const mutation = useChangePassword()
	const [current, setCurrent] = useState('')
	const [next, setNext] = useState('')
	const [confirm, setConfirm] = useState('')
	const [touched, setTouched] = useState({ current: false, next: false, confirm: false })
	const [serverError, setServerError] = useState<string | null>(null)

	const errors = validate(current, next, confirm, touched)
	const allTouched = { current: true, next: true, confirm: true }
	const fullErrors = validate(current, next, confirm, allTouched)
	const isValid = Object.keys(fullErrors).length === 0

	function reset() {
		setCurrent('')
		setNext('')
		setConfirm('')
		setTouched({ current: false, next: false, confirm: false })
		setServerError(null)
		mutation.reset()
	}

	function handleOpenChange(value: boolean) {
		if (!value) reset()
		onOpenChange(value)
	}

	async function handleSubmit(e: FormEvent) {
		e.preventDefault()
		setTouched(allTouched)
		if (!isValid) return

		setServerError(null)
		try {
			await mutation.mutateAsync({ current_password: current, new_password: next })
			trackEvent('profile.field_changed', { field: 'password' })
			toast.success('Password updated')
			onOpenChange(false)
			reset()
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				// 401 from /auth/password means the current password is wrong.
				setServerError('Current password is incorrect.')
				setTouched(allTouched)
			} else {
				setServerError(err instanceof Error ? err.message : 'Could not update password.')
			}
		}
	}

	const currentError = serverError ?? errors.current_password

	return (
		<ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
			<ResponsiveDialogContent>
				<form onSubmit={handleSubmit} className="contents">
					<ResponsiveDialogHeader>
						<ResponsiveDialogTitle>Change password</ResponsiveDialogTitle>
						<ResponsiveDialogDescription>
							You'll stay signed in on this device after the change.
						</ResponsiveDialogDescription>
					</ResponsiveDialogHeader>

					<div className="flex flex-col gap-4 py-2">
						<Field
							id="current_password"
							label="Current password"
							type="password"
							value={current}
							onChange={(v) => {
								setCurrent(v)
								if (serverError) setServerError(null)
							}}
							onBlur={() => setTouched((t) => ({ ...t, current: true }))}
							error={currentError}
							autoComplete="current-password"
						/>
						<Field
							id="new_password"
							label="New password"
							type="password"
							value={next}
							onChange={setNext}
							onBlur={() => setTouched((t) => ({ ...t, next: true }))}
							error={errors.new_password}
							autoComplete="new-password"
							hint={`At least ${MIN_LENGTH} characters.`}
						/>
						<Field
							id="confirm_password"
							label="Confirm new password"
							type="password"
							value={confirm}
							onChange={setConfirm}
							onBlur={() => setTouched((t) => ({ ...t, confirm: true }))}
							error={errors.confirm_password}
							autoComplete="new-password"
						/>
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
							{mutation.isPending ? 'Updating…' : 'Update password'}
						</Button>
					</ResponsiveDialogFooter>
				</form>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
