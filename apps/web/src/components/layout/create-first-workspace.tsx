import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/hooks/use-auth'
import { useCreateWorkspace } from '@/hooks/use-workspaces'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { createErrorMessage } from './new-workspace-dialog'

/**
 * Where a signed-in account with zero workspaces lands (e.g. after deleting
 * their last one). `/signup` creates a brand-new actor, so it is the wrong exit
 * for someone who already has an account: this screen creates a workspace for
 * the existing one, with the same hook and error copy as NewWorkspaceDialog.
 */
export function CreateFirstWorkspace() {
	const [name, setName] = useState('')
	const navigate = useNavigate()
	const { logout } = useAuth()
	const createMutation = useCreateWorkspace()
	const trimmed = name.trim()

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		if (!trimmed || createMutation.isPending) return
		createMutation.mutate(
			{ name: trimmed },
			{
				onSuccess: (workspace) => {
					navigate({ to: '/$workspaceId', params: { workspaceId: workspace.id } })
				},
			},
		)
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-4 py-8">
			<form onSubmit={handleSubmit} className="w-full max-w-sm">
				<h1 className="text-[17px] font-bold text-foreground">Create your first workspace</h1>
				<p className="mt-1 text-sm text-muted-foreground">
					You're not in any workspace yet. Name one to get started — your default agent crew comes
					with it.
				</p>
				<div className="mt-5 grid gap-2">
					<Label htmlFor="first-workspace-name">Workspace name</Label>
					<Input
						id="first-workspace-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Nordic Labs"
						autoFocus
					/>
					<FormError error={createErrorMessage(createMutation.error)} />
				</div>
				<Button
					type="submit"
					className="mt-4 w-full"
					disabled={!trimmed || createMutation.isPending}
				>
					{createMutation.isPending ? 'Creating…' : 'Create workspace'}
				</Button>
				<div className="mt-3 flex justify-center">
					<Button type="button" variant="ghost" onClick={logout}>
						Sign out
					</Button>
				</div>
			</form>
		</div>
	)
}
