import { AgentAccess } from '@/components/integrations/agent-access'
import { ProviderCard } from '@/components/integrations/provider-card'
import { CredentialEditDialog } from '@/components/keychain/credential-edit-dialog'
import { credentialName, credentialTypeLabel } from '@/components/keychain/keychain-parts'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { useRemoveCredential } from '@/hooks/use-integrations'
import type { IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'

/**
 * One saved credential, drawn like a connected integration: dot, name, what it is, Remove,
 * and the same collapsible Agent access underneath. Overview-only; there is no detail page.
 */
export function CredentialCard({ credential }: { credential: IntegrationResponse }) {
	const { workspace, workspaceId } = useWorkspace()
	const remove = useRemoveCredential(workspaceId)
	const [confirming, setConfirming] = useState(false)
	const [editing, setEditing] = useState(false)

	const name = credentialName(credential)
	const isSavedSecret =
		credential.providerMode === 'byo_apikey' || credential.providerMode === 'byo_login'
	const me = getStoredActor()
	const isOwnerOrAdmin = workspace.role === 'owner' || workspace.role === 'admin'
	// A saved key or login can be removed by whoever saved it or a workspace admin or owner: the
	// secret is destroyed, not hidden. OAuth connections are disconnected on the Integrations page.
	const canRemove =
		isSavedSecret &&
		(credential.status === 'active' || credential.status === 'pending_undo') &&
		me?.type === 'human' &&
		(credential.createdBy === me.id || isOwnerOrAdmin)
	// Only an active key or login can be edited: one in its undo window is not saved yet.
	const canEdit = canRemove && credential.status === 'active'
	// A key still in its undo window is scoped by the chat card, and an OAuth connection keeps
	// its workspace grant, so only an active key or login has agents to assign here.
	const assignable = isSavedSecret && credential.status === 'active'
	const assigned = (credential.agentGrants ?? []).length > 0
	const subtitle = [
		credentialTypeLabel(credential.providerMode),
		credential.source === 'chat_capture' ? 'Captured via chat' : null,
	]
		.filter(Boolean)
		.join(' · ')

	return (
		<>
			<ProviderCard
				name={name}
				subtitle={subtitle}
				tone={assigned ? 'connected' : 'available'}
				actions={
					canRemove ? (
						<div className="flex shrink-0 items-center gap-1">
							{canEdit && (
								<Button
									variant="ghost"
									size="sm"
									className="text-muted-foreground"
									aria-label={`Edit ${name}`}
									onClick={() => setEditing(true)}
								>
									Edit
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								className="shrink-0 text-muted-foreground hover:text-error"
								aria-label={`Remove ${name}`}
								onClick={() => {
									remove.reset()
									setConfirming(true)
								}}
							>
								Remove
							</Button>
						</div>
					) : null
				}
				footer={
					assignable ? (
						<AgentAccess integration={credential} workspaceId={workspaceId} kind="key" />
					) : undefined
				}
			/>

			{canEdit && (
				<CredentialEditDialog
					open={editing}
					onOpenChange={setEditing}
					workspaceId={workspaceId}
					integrationId={credential.id}
					name={name}
					kind={credential.providerMode === 'byo_login' ? 'login' : 'api_key'}
				/>
			)}

			{canRemove && (
				<ResponsiveDialog open={confirming} onOpenChange={setConfirming}>
					<ResponsiveDialogContent>
						<ResponsiveDialogHeader>
							<ResponsiveDialogTitle>Remove {name}?</ResponsiveDialogTitle>
							<ResponsiveDialogDescription>
								The secret is destroyed and can't be recovered. Agents that use it can no longer
								start with it, and an agent that is running now keeps it until its session ends. You
								can add it again at any time.
							</ResponsiveDialogDescription>
						</ResponsiveDialogHeader>
						{remove.isError && (
							<p className="text-sm text-error" role="alert">
								Could not remove this credential. Try again.
							</p>
						)}
						<ResponsiveDialogFooter>
							<Button variant="ghost" onClick={() => setConfirming(false)}>
								Cancel
							</Button>
							<Button
								variant="destructive"
								disabled={remove.isPending}
								onClick={() =>
									remove.mutate(credential.id, { onSuccess: () => setConfirming(false) })
								}
							>
								{remove.isPending ? 'Removing…' : 'Remove'}
							</Button>
						</ResponsiveDialogFooter>
					</ResponsiveDialogContent>
				</ResponsiveDialog>
			)}
		</>
	)
}
