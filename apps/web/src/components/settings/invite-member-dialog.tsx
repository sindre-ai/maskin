import { FormError } from '@/components/shared/form-error'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useCreateInvite } from '@/hooks/use-invites'
import { ApiError, api } from '@/lib/api'
import { formatRetryAfter, inviteRoleLabel, isValidInviteEmail } from '@/lib/invite-format'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

// Owner is deliberately absent: ownership moves through transfer-ownership,
// never through an invite.
const INVITE_ROLES = ['member', 'viewer'] as const
type InviteRole = (typeof INVITE_ROLES)[number]

interface InviteError {
	message: string
	// Seat-cap rejections point at billing instead of just reporting the limit.
	upgrade?: boolean
}

function toInviteError(err: unknown, email: string): InviteError {
	if (err instanceof ApiError) {
		if (err.status === 409) {
			return { message: `${email} is already a member of this workspace.` }
		}
		if (err.status === 429) {
			const wait = formatRetryAfter(err.retryAfter)
			return {
				message: `Invite limit reached. 20 invites per day max.${wait ? ` Try again in ${wait}.` : ' Try again later.'}`,
			}
		}
		if (err.status === 403 && err.code === 'SEAT_CAP_EXCEEDED') {
			return { message: 'Your plan is at capacity.', upgrade: true }
		}
		return { message: err.message }
	}
	return { message: err instanceof Error ? err.message : 'Failed to send invite' }
}

export function InviteMemberDialog({
	open,
	onOpenChange,
	workspaceId,
	workspaceName,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	workspaceName: string
}) {
	const queryClient = useQueryClient()
	const createInvite = useCreateInvite(workspaceId)
	const [email, setEmail] = useState('')
	const [role, setRole] = useState<InviteRole>('member')
	const [touched, setTouched] = useState(false)
	const [error, setError] = useState<InviteError | null>(null)

	const trimmed = email.trim()
	const emailInvalid = touched && trimmed.length > 0 && !isValidInviteEmail(trimmed)

	const reset = () => {
		setEmail('')
		setRole('member')
		setTouched(false)
		setError(null)
	}

	const handleOpenChange = (next: boolean) => {
		if (createInvite.isPending) return
		if (!next) reset()
		onOpenChange(next)
	}

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!isValidInviteEmail(trimmed)) {
			setTouched(true)
			return
		}
		setError(null)
		try {
			const result = await createInvite.mutateAsync({ email: trimmed, role })
			if (result.status === 'linked') {
				// The response carries only ids; the members list (just invalidated)
				// has the display name.
				const members = await queryClient.fetchQuery({
					queryKey: queryKeys.workspaces.members(workspaceId),
					queryFn: () => api.workspaces.members.list(workspaceId),
					staleTime: 0,
				})
				const name = members.find((m) => m.actorId === result.member.actorId)?.name ?? trimmed
				toast.success(`${name} added as ${inviteRoleLabel(result.member.role)}.`)
			} else {
				toast.success(`Invite sent to ${result.invite.email}.`)
			}
			reset()
			onOpenChange(false)
		} catch (err) {
			setError(toInviteError(err, trimmed))
		}
	}

	return (
		<ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Invite member</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						They'll join <span className="font-medium text-foreground">{workspaceName}</span>.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4" noValidate>
					<div>
						<Label htmlFor="invite-email" className="mb-1 text-muted-foreground">
							Email address
						</Label>
						<Input
							id="invite-email"
							type="email"
							value={email}
							onChange={(e) => {
								setEmail(e.target.value)
								setError(null)
							}}
							onBlur={() => setTouched(true)}
							placeholder="colleague@company.com"
							autoComplete="off"
							autoFocus
							disabled={createInvite.isPending}
							aria-invalid={emailInvalid || undefined}
							aria-describedby={emailInvalid ? 'invite-email-error' : undefined}
						/>
						{emailInvalid && (
							<div id="invite-email-error">
								<FormError error="Enter a valid email address." />
							</div>
						)}
					</div>
					<div>
						<Label htmlFor="invite-role" className="mb-1 text-muted-foreground">
							Role
						</Label>
						<Select
							value={role}
							onValueChange={(value) => setRole(value as InviteRole)}
							disabled={createInvite.isPending}
						>
							<SelectTrigger id="invite-role" aria-label="Role for the new member">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{INVITE_ROLES.map((r) => (
									<SelectItem key={r} value={r}>
										{inviteRoleLabel(r)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<p className="mt-1 text-xs text-muted-foreground">
							Members can create and edit. Viewers can only read.
						</p>
					</div>
					{error && (
						<div role="alert">
							<FormError error={error.message} />
							{error.upgrade && (
								<p className="mt-1 text-xs text-error">
									<Link
										to="/$workspaceId/settings/billing"
										params={{ workspaceId }}
										className="underline"
										onClick={() => handleOpenChange(false)}
									>
										Upgrade to add more.
									</Link>
								</p>
							)}
						</div>
					)}
					<ResponsiveDialogFooter>
						<Button
							type="button"
							variant="ghost"
							onClick={() => handleOpenChange(false)}
							disabled={createInvite.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={!isValidInviteEmail(trimmed) || createInvite.isPending}>
							{createInvite.isPending ? 'Sending…' : 'Send invite'}
						</Button>
					</ResponsiveDialogFooter>
				</form>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}
