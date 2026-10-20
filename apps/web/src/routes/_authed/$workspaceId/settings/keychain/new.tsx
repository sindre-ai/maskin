import { KeychainBreadcrumb } from '@/components/keychain/keychain-parts'
import { SecretInput } from '@/components/keychain/secret-input'
import { FormError } from '@/components/shared/form-error'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useDocumentTitle } from '@/hooks/use-document-title'
import { useCreateByoApiKey, useCreateByoLogin } from '@/hooks/use-integrations'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import {
	CREDENTIAL_NAME_MAX_LENGTH,
	checkCredentialName,
	credentialNameMessage,
} from '@maskin/shared'
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
	const createKey = useCreateByoApiKey(workspaceId)
	const createLogin = useCreateByoLogin(workspaceId)
	const [kind, setKind] = useState<'api_key' | 'login'>('api_key')
	const [name, setName] = useState('')
	const [secret, setSecret] = useState('')
	const [username, setUsername] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const isLogin = kind === 'login'
	const pending = createKey.isPending || createLogin.isPending

	// The same rule the server applies, so the message appears before a request.
	const nameProblem = name.trim() ? checkCredentialName(name) : null
	const hasValue = isLogin ? username.trim().length > 0 && password.length > 0 : secret.length > 0
	const canSave = name.trim().length > 0 && !nameProblem && hasValue && !pending

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault()
		if (!canSave) return
		setError(null)
		try {
			const { integrationId } = isLogin
				? await createLogin.mutateAsync({
						displayName: name.trim(),
						username: username.trim(),
						password,
					})
				: await createKey.mutateAsync({ displayName: name.trim(), rawSecret: secret })
			// The value is gone from the page the moment it is saved.
			setSecret('')
			setPassword('')
			navigate({
				to: '/$workspaceId/settings/keychain/$integrationId',
				params: { workspaceId, integrationId },
			})
		} catch (err) {
			// A taken or secret-shaped name has a message a person can act on. Anything else
			// stays generic: the server names the bad field, not what to do about it.
			setError(
				err instanceof ApiError &&
					(err.code === 'NAME_TAKEN' || err.code === 'NAME_LOOKS_LIKE_SECRET')
					? err.message
					: isLogin
						? 'Could not save this login. Check the name, username and password, then try again.'
						: 'Could not save this credential. Check the name and secret, then try again.',
			)
		}
	}

	return (
		<div className="max-w-[640px]">
			<KeychainBreadcrumb workspaceId={workspaceId} current="Add credential" />
			<h2 className="text-sm font-bold text-foreground">Add a credential</h2>
			<p className="mt-1 mb-4 text-xs text-muted-foreground">
				Choose how you'll bring the credential into Maskin. Pick which agents can use it on the key
				page.
			</p>

			<ul className="mb-4 grid gap-3 sm:grid-cols-2">
				<li className={cn(CARD, 'border-primary ring-2 ring-ring')} aria-current="true">
					<div aria-hidden>📋</div>
					<div className="mt-1 text-sm font-semibold">Paste a secret</div>
					<p className="mt-1 text-xs text-muted-foreground">
						API key, Bearer token, or Basic Auth. Fastest for services you already have credentials
						for.
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
				<Tabs value={kind} onValueChange={(v) => setKind(v as 'api_key' | 'login')}>
					<TabsList variant="segmented" aria-label="Credential type">
						<TabsTrigger value="api_key">API key</TabsTrigger>
						<TabsTrigger value="login">Login</TabsTrigger>
					</TabsList>
				</Tabs>
				<div className="space-y-1.5">
					<Label htmlFor="keychain-name">Name</Label>
					<Input
						id="keychain-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder={isLogin ? 'e.g. "e-conomic"' : 'e.g. "Stripe"'}
						maxLength={CREDENTIAL_NAME_MAX_LENGTH}
						autoComplete="off"
						aria-invalid={nameProblem ? true : undefined}
						required
					/>
					{nameProblem ? (
						<p className="text-xs text-error">{credentialNameMessage(nameProblem)}</p>
					) : (
						<p className="text-xs text-muted-foreground">What agents will see.</p>
					)}
				</div>
				{isLogin ? (
					<>
						<div className="space-y-1.5">
							<Label htmlFor="keychain-username">Username or email</Label>
							<Input
								id="keychain-username"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								autoComplete="off"
								spellCheck={false}
								required
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="keychain-password">Password</Label>
							<SecretInput id="keychain-password" value={password} onChange={setPassword} />
							<p className="text-xs text-muted-foreground">
								Encrypted at rest. Never displayed after save.
							</p>
						</div>
					</>
				) : (
					<div className="space-y-1.5">
						<Label htmlFor="keychain-secret">Secret</Label>
						<SecretInput id="keychain-secret" value={secret} onChange={setSecret} />
						<p className="text-xs text-muted-foreground">
							Encrypted at rest. Never displayed after save.
						</p>
					</div>
				)}
				<FormError error={error ?? undefined} />
				<div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
					<Button asChild type="button" variant="ghost">
						<Link to="/$workspaceId/settings/keychain" params={{ workspaceId }}>
							Cancel
						</Link>
					</Button>
					<Button type="submit" disabled={!canSave}>
						{pending ? 'Saving…' : 'Save'}
					</Button>
				</div>
			</form>
		</div>
	)
}
