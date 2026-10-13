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
import { useDeleteWorkspace, useWorkspaceDeletionPreview } from '@/hooks/use-workspaces'
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
	const preview = useWorkspaceDeletionPreview(workspaceId, open)
	const deleteWorkspace = useDeleteWorkspace(workspaceId)
	const [confirmName, setConfirmName] = useState('')

	const canDelete = preview.data?.can_delete === true
	const nameMatches = confirmName === workspaceName

	const handleOpenChange = (next: boolean) => {
		if (deleteWorkspace.isPending) return
		if (!next) {
			setConfirmName('')
			deleteWorkspace.reset()
		}
		onOpenChange(next)
	}

	const handleDelete = () => {
		deleteWorkspace.mutate(confirmName, {
			onSuccess: () => {
				toast.success(`Deleted ${workspaceName}`)
				// The index route lands on the one remaining workspace, or the picker.
				navigate({ to: '/' })
			},
		})
	}

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Delete {workspaceName}</DialogTitle>
					<DialogDescription>
						This permanently deletes the workspace and everything in it: bets, insights, tasks,
						agents, chats and files. It cannot be undone.
					</DialogDescription>
				</DialogHeader>

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
						variant="outline"
						onClick={() => handleOpenChange(false)}
						disabled={deleteWorkspace.isPending}
					>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={!canDelete || !nameMatches || deleteWorkspace.isPending}
					>
						{deleteWorkspace.isPending ? 'Deleting…' : 'Delete workspace'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
