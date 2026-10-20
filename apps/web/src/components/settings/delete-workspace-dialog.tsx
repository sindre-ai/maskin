import { DeleteAccountDialog } from '@/components/profile/delete-account-dialog'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
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
import {
	removeDeletedWorkspaceQueries,
	useDeleteWorkspace,
	useWorkspaceDeletionPreview,
	useWorkspaces,
} from '@/hooks/use-workspaces'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { toast } from 'sonner'

export function DeleteWorkspaceDialog({
	workspaceId,
	workspaceName,
	open,
	onOpenChange,
}: {
	workspaceId: string
	workspaceName: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const navigate = useNavigate()
	const queryClient = useQueryClient()
	const { data: workspaces } = useWorkspaces()
	// Deleting the only workspace leaves the person with nothing to open, so we offer to delete the
	// account too. Caches stay alive until that prompt is done: this page is still mounted behind it.
	const isLastWorkspace = workspaces?.length === 1 && workspaces[0].id === workspaceId
	const preview = useWorkspaceDeletionPreview(workspaceId, open)
	const deleteWorkspace = useDeleteWorkspace(workspaceId, { deferCleanup: isLastWorkspace })
	const [confirmName, setConfirmName] = useState('')
	const [step, setStep] = useState<'confirm' | 'no-workspaces-left'>('confirm')
	const [accountOpen, setAccountOpen] = useState(false)

	const canDelete = preview.data?.can_delete === true
	const nameMatches = confirmName === workspaceName

	const handleOpenChange = (next: boolean) => {
		if (deleteWorkspace.isPending) return
		if (step === 'no-workspaces-left') {
			if (!next) finishWithoutAccountDeletion()
			return
		}
		if (!next) {
			setConfirmName('')
			deleteWorkspace.reset()
		}
		onOpenChange(next)
	}

	const finishWithoutAccountDeletion = () => {
		removeDeletedWorkspaceQueries(queryClient, workspaceId)
		setStep('confirm')
		setAccountOpen(false)
		onOpenChange(false)
		// Lands on the index route, which has no workspace to open (see report).
		navigate({ to: '/' })
	}

	const handleDelete = (e?: React.FormEvent) => {
		e?.preventDefault()
		if (!canDelete || !nameMatches || deleteWorkspace.isPending) return
		deleteWorkspace.mutate(confirmName, {
			onSuccess: () => {
				toast.success(`Deleted ${workspaceName}`)
				if (isLastWorkspace) {
					setStep('no-workspaces-left')
					return
				}
				// The index route lands on the last-opened remaining workspace.
				navigate({ to: '/' })
			},
		})
	}

	if (accountOpen) {
		return (
			<DeleteAccountDialog
				open
				onOpenChange={(next) => {
					if (!next) finishWithoutAccountDeletion()
				}}
			/>
		)
	}

	if (step === 'no-workspaces-left') {
		return (
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>You have no workspaces left</DialogTitle>
						<DialogDescription>
							Delete your account too? You can also keep it and create a new workspace later.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button variant="outline" onClick={finishWithoutAccountDeletion}>
							Not now
						</Button>
						<Button variant="destructive" onClick={() => setAccountOpen(true)}>
							Delete account
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		)
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<form onSubmit={handleDelete} className="contents">
					<DialogHeader>
						<DialogTitle>Delete {workspaceName}</DialogTitle>
						<DialogDescription>
							This permanently deletes the workspace and everything in it: bets, insights, tasks,
							agents, chats and files. It cannot be undone.
						</DialogDescription>
					</DialogHeader>

					{isLastWorkspace && (
						<p className="text-sm text-muted-foreground">
							This is your only workspace. You will have no workspaces left, and we will ask whether
							you also want to delete your account.
						</p>
					)}

					{preview.isLoading && (
						<div className="flex justify-center py-4">
							<Spinner />
						</div>
					)}
					{preview.isError && (
						<FormError error="Could not check whether this workspace can be deleted." />
					)}

					{preview.data && (
						<div className="space-y-3">
							{preview.data.other_members > 0 && (
								<p className="text-sm text-muted-foreground">
									{preview.data.other_members === 1
										? '1 other member'
										: `${preview.data.other_members} other members`}{' '}
									will lose access.
								</p>
							)}
							{preview.data.blockers.length > 0 && (
								<ul className="space-y-1 rounded-md border border-border bg-card p-3 text-sm">
									{preview.data.blockers.map((blocker) => (
										<li key={blocker.code} className="text-error">
											{blocker.message}
										</li>
									))}
								</ul>
							)}
							{canDelete && (
								<div>
									<Label htmlFor="delete-workspace-confirm" className="mb-1">
										Type <span className="font-mono font-semibold">{workspaceName}</span> to confirm
									</Label>
									<Input
										id="delete-workspace-confirm"
										value={confirmName}
										onChange={(e) => setConfirmName(e.target.value)}
										autoComplete="off"
									/>
								</div>
							)}
						</div>
					)}

					<FormError error={deleteWorkspace.isError ? deleteWorkspace.error.message : undefined} />

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={deleteWorkspace.isPending}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							variant="destructive"
							disabled={!canDelete || !nameMatches || deleteWorkspace.isPending}
						>
							{deleteWorkspace.isPending ? 'Deleting…' : 'Delete workspace'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
