import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useState } from 'react'

interface VaerkstedCompleteProfileProps {
	open: boolean
	/** Shown in the description for context — the account this profile belongs to. */
	email: string | null
	loading: boolean
	onSubmit: (input: { name: string; organization: string; role: string }) => void
}

/**
 * Shown once, right after a brand-new "Continue with vaerksted" signup
 * (VaerkstedAuthButton, useVaerkstedAuth's `pendingProfile`) — the vaerksted
 * identity handshake proves *who* someone is but never asks *what to call
 * them* or *what they're working on*, unlike the native /signup form's
 * Name/Organization/Role fields. Same three fields, same validation, same
 * destination (packages/shared/src/schemas/signup-capture.ts's knowledge
 * object) — just collected a step later, after identity instead of before.
 *
 * Deliberately not dismissable (no close button behavior, ignores outside
 * click / Escape) — the account already exists and works either way, but
 * skipping this silently would leave every future signup missing the
 * onboarding context the Strategist agent's research-on-signup trigger
 * depends on, with no later prompt to fill it in.
 */
export function VaerkstedCompleteProfile({
	open,
	email,
	loading,
	onSubmit,
}: VaerkstedCompleteProfileProps) {
	const [name, setName] = useState('')
	const [organization, setOrganization] = useState('')
	const [role, setRole] = useState('')
	const [error, setError] = useState('')

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		const trimmedName = name.trim()
		const trimmedOrg = organization.trim()
		const trimmedRole = role.trim()
		if (!trimmedName) {
			setError('Name is required')
			return
		}
		if (!trimmedOrg) {
			setError('Organization is required')
			return
		}
		if (!trimmedRole) {
			setError('Role is required')
			return
		}
		setError('')
		onSubmit({ name: trimmedName, organization: trimmedOrg, role: trimmedRole })
	}

	return (
		<Dialog open={open} onOpenChange={() => {}}>
			<DialogContent
				className="sm:max-w-sm [&>button]:hidden"
				onEscapeKeyDown={(e) => e.preventDefault()}
				onPointerDownOutside={(e) => e.preventDefault()}
			>
				<DialogHeader>
					<DialogTitle>Complete your profile</DialogTitle>
					<DialogDescription>
						{email ? `Signed in as ${email}` : "You're signed in"} — just a couple more details.
					</DialogDescription>
				</DialogHeader>

				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<Label className="mb-1 text-muted-foreground">Name</Label>
						<Input
							type="text"
							value={name}
							onChange={(e) => {
								setName(e.target.value)
								setError('')
							}}
							placeholder="Your name"
							autoFocus
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Organization</Label>
						<Input
							type="text"
							value={organization}
							onChange={(e) => {
								setOrganization(e.target.value)
								setError('')
							}}
							placeholder="Company name"
						/>
					</div>

					<div>
						<Label className="mb-1 text-muted-foreground">Role</Label>
						<Input
							type="text"
							value={role}
							onChange={(e) => {
								setRole(e.target.value)
								setError('')
							}}
							placeholder="What you do"
						/>
					</div>

					{error && <p className="text-xs text-error">{error}</p>}

					<Button type="submit" disabled={loading} className="w-full">
						{loading ? 'Saving…' : 'Continue'}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	)
}
