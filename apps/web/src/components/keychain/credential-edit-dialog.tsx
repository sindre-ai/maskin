import { SecretInput } from '@/components/keychain/secret-input'
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
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useUpdateCredential } from '@/hooks/use-integrations'
import { ApiError } from '@/lib/api'
import {
	CREDENTIAL_NAME_MAX_LENGTH,
	checkCredentialName,
	credentialNameMessage,
} from '@maskin/shared'
import { useId, useState } from 'react'

interface CredentialEditDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	workspaceId: string
	integrationId: string
	name: string
	kind: 'api_key' | 'login'
}

/** A taken or secret-shaped name has a message a person can act on; anything else stays generic. */
export function editErrorMessage(error: unknown): string {
	if (
		error instanceof ApiError &&
		(error.code === 'NAME_TAKEN' || error.code === 'NAME_LOOKS_LIKE_SECRET' || error.status === 403)
	) {
		return error.message
	}
	return 'Could not save the changes. Check the fields, then try again.'
}

/**
 * Rename a saved key or login, replace its secret, or both. The current secret is never sent to
 * the browser, so the secret fields start empty and blank means "keep it". A login changes one
 * part at a time: fill only the password and the saved username stays.
 */
export function CredentialEditDialog({ open, onOpenChange, ...form }: CredentialEditDialogProps) {
	return (
		<ResponsiveDialog open={open} onOpenChange={onOpenChange}>
			<ResponsiveDialogContent>
				{/* Mounted with the dialog, so every open starts from the saved name and empty secrets. */}
				<EditForm {...form} onDone={() => onOpenChange(false)} />
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

function EditForm({
	workspaceId,
	integrationId,
	name: savedName,
	kind,
	onDone,
}: Omit<CredentialEditDialogProps, 'open' | 'onOpenChange'> & { onDone: () => void }) {
	const id = useId()
	const update = useUpdateCredential(workspaceId, integrationId)
	const isLogin = kind === 'login'
	const [name, setName] = useState(savedName)
	const [secret, setSecret] = useState('')
	const [username, setUsername] = useState('')
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const loginEmail = useFeatureFlag('keychain-login-email')

	const trimmed = name.trim()
	const renamed = trimmed !== savedName
	const nameProblem = trimmed ? checkCredentialName(trimmed) : null
	const hasSecret = isLogin
		? username.trim().length > 0 || password.length > 0 || (loginEmail && email.trim().length > 0)
		: secret.length > 0
	const canSave = trimmed.length > 0 && !nameProblem && (renamed || hasSecret) && !update.isPending

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault()
		if (!canSave) return
		const body: Parameters<typeof update.mutate>[0] = {}
		if (renamed) body.displayName = trimmed
		if (hasSecret) {
			if (isLogin) {
				if (username.trim()) body.username = username.trim()
				if (password) body.password = password
				if (loginEmail && email.trim()) body.email = email.trim()
			} else {
				body.rawSecret = secret
			}
		}
		update.mutate(body, {
			onSuccess: () => {
				// The values are gone from the page the moment they are saved.
				setSecret('')
				setPassword('')
				onDone()
			},
		})
	}

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			<ResponsiveDialogHeader>
				<ResponsiveDialogTitle>Edit {savedName}</ResponsiveDialogTitle>
				<ResponsiveDialogDescription>
					Change the name, the {isLogin ? 'login' : 'key'}, or both.{' '}
					{isLogin
						? 'Fill only what changes; empty fields keep their current value.'
						: 'Leave the key empty to keep the current one.'}{' '}
					Running sessions keep what they started with; the next one gets the change.
				</ResponsiveDialogDescription>
			</ResponsiveDialogHeader>

			<div className="space-y-1.5">
				<Label htmlFor={`${id}-name`}>Name</Label>
				<Input
					id={`${id}-name`}
					value={name}
					onChange={(e) => setName(e.target.value)}
					maxLength={CREDENTIAL_NAME_MAX_LENGTH}
					autoComplete="off"
					aria-invalid={nameProblem ? true : undefined}
					required
				/>
				{nameProblem ? (
					<p className="text-xs text-error">{credentialNameMessage(nameProblem)}</p>
				) : renamed ? (
					<p className="text-xs text-warning">
						Agents and tool servers that use this by its old name need the new one.
					</p>
				) : (
					<p className="text-xs text-muted-foreground">What agents will see.</p>
				)}
			</div>

			{isLogin ? (
				<>
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-username`}>
							{loginEmail ? 'New username' : 'New username or email'}
						</Label>
						<Input
							id={`${id}-username`}
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							autoComplete="off"
							spellCheck={false}
							placeholder="Leave empty to keep the current username"
						/>
					</div>
					{loginEmail && (
						<div className="space-y-1.5">
							<Label htmlFor={`${id}-email`}>New email</Label>
							<Input
								id={`${id}-email`}
								inputMode="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								autoComplete="off"
								spellCheck={false}
								placeholder="Leave empty to keep the current email, if any"
							/>
						</div>
					)}
					<div className="space-y-1.5">
						<Label htmlFor={`${id}-password`}>New password</Label>
						<SecretInput
							id={`${id}-password`}
							value={password}
							onChange={setPassword}
							required={false}
							placeholder="Leave empty to keep the current password"
						/>
					</div>
				</>
			) : (
				<div className="space-y-1.5">
					<Label htmlFor={`${id}-secret`}>New secret</Label>
					<SecretInput
						id={`${id}-secret`}
						value={secret}
						onChange={setSecret}
						required={false}
						placeholder="Leave empty to keep the current key"
					/>
				</div>
			)}

			{update.isError && (
				<p role="alert" className="text-sm text-error">
					{editErrorMessage(update.error)}
				</p>
			)}

			<ResponsiveDialogFooter>
				<Button type="button" variant="ghost" onClick={onDone}>
					Cancel
				</Button>
				<Button type="submit" disabled={!canSave}>
					{update.isPending ? 'Saving…' : 'Save'}
				</Button>
			</ResponsiveDialogFooter>
		</form>
	)
}
