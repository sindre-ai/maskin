import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useVaerkstedAuth } from '@/hooks/use-vaerksted-auth'
import { getStoredActor } from '@/lib/auth'
import { Navigate, createFileRoute, useSearch } from '@tanstack/react-router'
import { useState } from 'react'

/**
 * Full-page fallback for a brand-new "Continue with vaerksted" actor whose
 * name/organization/role never got collected — /signup asks for these
 * inline before sending the magic link, but /login only asks for email, so
 * a never-before-seen email typed into /login skips straight to identity
 * verification with nothing to apply (see use-vaerksted-auth.ts's
 * completeFromRedirect(), which routes here instead of '/' for exactly this
 * case). Same three questions, same layout /signup uses — deliberately a
 * full page, not a post-redirect popup.
 */
export const Route = createFileRoute('/_authed/complete-profile')({
	validateSearch: (search: Record<string, unknown>) => ({
		workspace_id: typeof search.workspace_id === 'string' ? search.workspace_id : undefined,
	}),
	component: CompleteProfilePage,
})

function CompleteProfilePage() {
	const { workspace_id: workspaceId } = useSearch({ from: '/_authed/complete-profile' })
	const { loading, submitProfile } = useVaerkstedAuth()
	const actor = getStoredActor()
	const [name, setName] = useState('')
	const [organization, setOrganization] = useState('')
	const [role, setRole] = useState('')
	const [error, setError] = useState('')

	// Reached this route without a stored actor (direct navigation, stale
	// bookmark) — nothing to complete a profile for.
	if (!actor) {
		return <Navigate to="/login" />
	}

	const handleSubmit = async (e: React.FormEvent) => {
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
		try {
			await submitProfile(workspaceId, {
				name: trimmedName,
				organization: trimmedOrg,
				role: trimmedRole,
			})
		} catch (err) {
			setError(err instanceof Error ? err.message : 'Failed to save your profile')
		}
	}

	return (
		<div className="flex min-h-screen items-center justify-center">
			<div className="w-full max-w-sm space-y-6">
				<div className="text-center">
					<h1 className="text-2xl font-semibold tracking-tight">Complete your profile</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{actor.email ? `Signed in as ${actor.email}` : "You're signed in"} — just a couple more
						details
					</p>
				</div>

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
			</div>
		</div>
	)
}
