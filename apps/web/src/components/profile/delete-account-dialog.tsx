import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { useAccountDeletionPreview, useDeleteAccount } from '@/hooks/use-account'
import { ApiError } from '@/lib/api'
import { Link, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

const BLOCKER_COPY = {
	transfer_ownership: {
		text: 'You pay for this workspace and other people use it. Transfer ownership first.',
		to: '/$workspaceId/settings/members',
		action: 'Open members',
	},
	cancel_plan: {
		text: 'You pay for a plan on this workspace. Cancel it first.',
		to: '/$workspaceId/settings/billing',
		action: 'Open billing',
	},
} as const

function plural(count: number, one: string, many: string) {
	return count === 1 ? `${count} ${one}` : `${count} ${many}`
}

export function DeleteAccountDialog({
	open,
	onOpenChange,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const navigate = useNavigate()
	const [password, setPassword] = useState('')
	const [deleteSole, setDeleteSole] = useState(false)
	// The flag changes which blockers apply (a sole workspace with a live plan), so the preview follows it.
	const preview = useAccountDeletionPreview(open, deleteSole)
	const deleteAccount = useDeleteAccount()

	const soleWorkspaces = preview.data?.leaving.filter((w) => w.will_delete) ?? []
	const sharedWorkspaces = preview.data?.leaving.filter((w) => !w.will_delete) ?? []

	const handleOpenChange = (next: boolean) => {
		if (deleteAccount.isPending) return
		if (!next) {
			setPassword('')
			setDeleteSole(false)
			deleteAccount.reset()
		}
		onOpenChange(next)
	}

	const handleDelete = (e?: React.FormEvent) => {
		e?.preventDefault()
		if (!canSubmit) return
		deleteAccount.mutate(
			{ password, delete_sole_workspaces: deleteSole },
			{ onSuccess: () => navigate({ to: '/login' }) },
		)
	}

	const canSubmit =
		!!preview.data?.can_delete &&
		!preview.isPlaceholderData &&
		password.length > 0 &&
		!deleteAccount.isPending

	const error = deleteAccount.error
	const errorMessage =
		error instanceof ApiError && error.status === 401
			? 'Wrong password.'
			: error
				? error.message
				: undefined

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent className="max-h-[90dvh] overflow-y-auto">
				<form onSubmit={handleDelete} className="contents">
					<DialogHeader>
						<DialogTitle>Delete your account</DialogTitle>
						<DialogDescription>
							This permanently deletes your account and signs you out everywhere. It cannot be
							undone.
						</DialogDescription>
					</DialogHeader>

					{preview.isLoading && (
						<div className="flex justify-center py-4">
							<Spinner />
						</div>
					)}
					{preview.isError && (
						<FormError error="Could not check whether your account can be deleted." />
					)}

					{preview.data && (
						<div className="space-y-3 text-sm">
							{preview.data.blockers.length > 0 && (
								<ul className="space-y-2 rounded-md border border-border bg-card p-3">
									{preview.data.blockers.map((blocker) => {
										const copy = BLOCKER_COPY[blocker.code]
										return (
											<li key={`${blocker.code}-${blocker.workspace_id}`}>
												<span className="font-semibold">{blocker.workspace_name}</span>
												<span className="text-error"> {copy.text}</span>{' '}
												<Link
													to={copy.to}
													params={{ workspaceId: blocker.workspace_id }}
													onClick={() => handleOpenChange(false)}
													className="text-brand hover:text-brand-hover"
												>
													{copy.action}
												</Link>
											</li>
										)
									})}
								</ul>
							)}

							{sharedWorkspaces.length > 0 && (
								<div>
									<p className="text-muted-foreground">You will leave these workspaces:</p>
									<ul className="mt-1 list-disc pl-5">
										{sharedWorkspaces.map((w) => (
											<li key={w.workspace_id}>
												{w.workspace_name}{' '}
												<span className="text-muted-foreground">
													({plural(w.other_members, 'other member', 'other members')})
												</span>
											</li>
										))}
									</ul>
								</div>
							)}

							{soleWorkspaces.length > 0 && (
								<div className="space-y-2">
									<p className="text-muted-foreground">
										You are the only person in{' '}
										{plural(soleWorkspaces.length, 'workspace', 'workspaces')}:
									</p>
									<ul className="list-disc pl-5">
										{soleWorkspaces.map((w) => (
											<li key={w.workspace_id}>{w.workspace_name}</li>
										))}
									</ul>
									<div className="flex items-start gap-2">
										<Checkbox
											id="delete-sole-workspaces"
											checked={deleteSole}
											onCheckedChange={(checked) => setDeleteSole(checked === true)}
										/>
										<Label htmlFor="delete-sole-workspaces" className="font-normal">
											Also permanently delete{' '}
											{soleWorkspaces.length === 1 ? 'this workspace' : 'these workspaces'}.
											Otherwise {soleWorkspaces.length === 1 ? 'it stays' : 'they stay'}, with no
											one able to open
											{soleWorkspaces.length === 1 ? ' it' : ' them'}.
										</Label>
									</div>
								</div>
							)}

							{preview.data.can_delete && (
								<div>
									<Label htmlFor="delete-account-password" className="mb-1">
										Enter your password to confirm
									</Label>
									<Input
										id="delete-account-password"
										type="password"
										value={password}
										onChange={(e) => setPassword(e.target.value)}
										autoComplete="current-password"
									/>
								</div>
							)}
						</div>
					)}

					<FormError error={errorMessage} />

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={deleteAccount.isPending}
						>
							Cancel
						</Button>
						<Button type="submit" variant="destructive" disabled={!canSubmit}>
							{deleteAccount.isPending ? 'Deleting…' : 'Delete account'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
