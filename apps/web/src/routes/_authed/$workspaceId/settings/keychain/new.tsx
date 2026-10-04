import { KeychainBreadcrumb } from '@/components/keychain/keychain-parts'
import { FormError } from '@/components/shared/form-error'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useCreateByoApiKey } from '@/hooks/use-integrations'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/keychain/new')({
	component: AddCredentialPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

const CARD = 'rounded-lg border p-3 text-left'

function AddCredentialPage() {
	useDocumentTitle('Add a credential')
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const create = useCreateByoApiKey(workspaceId)
	const [name, setName] = useState('')
	const [secret, setSecret] = useState('')
	const [reveal, setReveal] = useState(false)
	const [error, setError] = useState<string | null>(null)

	const canSave = name.trim().length > 0 && secret.length > 0 && !create.isPending

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!canSave) return
		setError(null)
		try {
			const { integrationId } = await create.mutateAsync({
				displayName: name.trim(),
				rawSecret: secret,
			})
			// The value is gone from the page the moment it is saved.
			setSecret('')
			navigate({
				to: '/$workspaceId/settings/keychain/$integrationId',
				params: { workspaceId, integrationId },
			})
		} catch {
			// The server names the bad field; a person needs to know what to do, not which key it was.
			setError('Could not save this credential. Check the name and secret, then try again.')
		}
	}

	return (
		<div className="max-w-[640px]">
			<KeychainBreadcrumb workspaceId={workspaceId} current="Add credential" />
			<h2 className="text-sm font-bold text-foreground">Add a credential</h2>
			<p className="mt-1 mb-4 text-xs text-muted-foreground">
				Choose how you'll bring the credential into Maskin. You can always change scope later.
			</p>

			<ul className="mb-4 grid gap-3 sm:grid-cols-3">
				<li className={cn(CARD, 'border-primary ring-2 ring-ring')} aria-current="true">
					<div aria-hidden>📋</div>
					<div className="mt-1 text-sm font-semibold">Paste a secret</div>
					<p className="mt-1 text-xs text-muted-foreground">
						API key, Bearer token, or Basic Auth. Fastest for services you already have credentials
						for.
					</p>
				</li>
				<li className={cn(CARD, 'opacity-60')} aria-disabled="true">
					<div aria-hidden>🔗</div>
					<div className="mt-1 text-sm font-semibold">Connect via OAuth</div>
					<p className="mt-1 text-xs text-muted-foreground">
						Bring your own OAuth app; Maskin runs the auth dance and stores the resulting tokens.
					</p>
				</li>
				<li>
					<Link
						to="/$workspaceId/chats"
						params={{ workspaceId }}
						className={cn(CARD, 'block h-full transition-colors hover:bg-muted')}
					>
						<div aria-hidden>💬</div>
						<div className="mt-1 text-sm font-semibold">Capture from a chat</div>
						<p className="mt-1 text-xs text-muted-foreground">
							Open a chat session and paste the key inline — Maskin detects and vaults it.
						</p>
					</Link>
				</li>
			</ul>

			<form onSubmit={handleSubmit} className="space-y-4 rounded-lg border border-border p-4">
				<div className="space-y-1.5">
					<Label htmlFor="keychain-name">Name</Label>
					<Input
						id="keychain-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder='e.g. "Stripe · Sindre AI"'
						maxLength={80}
						autoComplete="off"
						required
					/>
					<p className="text-xs text-muted-foreground">What agents will see.</p>
				</div>
				<div className="space-y-1.5">
					<Label htmlFor="keychain-secret">Secret</Label>
					<div className="relative">
						<Input
							id="keychain-secret"
							type={reveal ? 'text' : 'password'}
							value={secret}
							onChange={(e) => setSecret(e.target.value)}
							className="pr-16 font-mono"
							autoComplete="new-password"
							spellCheck={false}
							required
						/>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							className="absolute top-1/2 right-1 h-7 -translate-y-1/2 px-2"
							aria-pressed={reveal}
							onClick={() => setReveal((r) => !r)}
						>
							{reveal ? 'Hide' : 'Show'}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						Encrypted at rest. Never displayed after save.
					</p>
				</div>
				<FormError error={error ?? undefined} />
				<div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
					<Button asChild type="button" variant="ghost">
						<Link to="/$workspaceId/settings/keychain" params={{ workspaceId }}>
							Cancel
						</Link>
					</Button>
					<Button type="submit" disabled={!canSave}>
						{create.isPending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</form>
		</div>
	)
}
