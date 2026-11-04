import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useCompleteIntegration,
	useConnectIntegration,
	useLinkGithubInstallation,
	useLinkableGithubInstallations,
} from '@/hooks/use-integrations'
import type { ProviderInfo } from '@/lib/api'
import { Check, Copy, Plus } from 'lucide-react'
import { useState } from 'react'

export function ApiKeyDialog({
	workspaceId,
	provider,
	apiKey,
	onApiKeyChange,
	onClose,
	returnTo,
}: {
	workspaceId: string
	provider: ProviderInfo | null
	apiKey: string
	onApiKeyChange: (value: string) => void
	onClose: () => void
	/** Where to land once the key is saved; absent means stay on the current page. */
	returnTo?: string
}) {
	const connect = useConnectIntegration(workspaceId)
	const canWrite = useCanWrite()

	const open = !!provider
	const handleConnect = () => {
		if (!provider || !canWrite) return
		connect.mutate(
			{ provider: provider.name, apiKey, returnTo },
			{
				onSuccess: () => {
					onClose()
				},
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect {provider?.displayName}</DialogTitle>
					<DialogDescription>
						Enter your {provider?.displayName} API key to store it for this workspace only.
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-2">
					<Label htmlFor="provider-api-key">API key</Label>
					<Input
						id="provider-api-key"
						type="password"
						value={apiKey}
						onChange={(e) => onApiKeyChange(e.target.value)}
						placeholder="Paste your API key"
					/>
				</div>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={handleConnect}
						disabled={!apiKey.trim() || connect.isPending || !canWrite}
					>
						Connect
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}

// Skjald connects from the Skjald app: its "Connect with Maskin" opens the page that picks a
// workspace (routes/connect.skjald.tsx) and hands the app its webhook URL and secret. Maskin cannot
// start that flow itself (the app holds the PKCE verifier), so the dialog says where to tap. The
// URL-and-secret steps stay behind "Set up manually" for anything that is not the app.
const SKJALD_APP_STEPS = [
	'Open Skjald and go to Settings → Send to.',
	'Tap Connect with Maskin.',
	'Sign in if asked, pick this workspace and press Connect. There is nothing to copy or paste.',
]

const SKJALD_SETUP_STEPS = [
	'In Skjald, go to Settings → Webhooks → Add Webhook and paste the URL below.',
	'Subscribe to the transcription.completed event.',
	'Set payload mode to "Full content" so the transcript is included.',
	'Copy the secret Skjald generates and paste it below to finish connecting.',
]

export function SkjaldConnectDialog({
	workspaceId,
	open,
	onClose,
}: {
	workspaceId: string
	open: boolean
	onClose: () => void
}) {
	const connect = useConnectIntegration(workspaceId)
	const complete = useCompleteIntegration(workspaceId)
	const canWrite = useCanWrite()
	const [step, setStep] = useState<'app' | 1 | 2>('app')
	const [manual, setManual] = useState<{ webhookUrl: string; integrationId: string } | null>(null)
	const [secret, setSecret] = useState('')
	const [copied, setCopied] = useState(false)

	const handleClose = () => {
		onClose()
		setStep('app')
		setManual(null)
		setSecret('')
		setCopied(false)
	}

	// The manual path is the only one that creates a row up front, so it is only started on request.
	const handleManual = () => {
		if (!canWrite) return
		connect.mutate(
			{ provider: 'skjald' },
			{
				onSuccess: (data) => {
					if (data.webhook_url && data.integration_id) {
						setManual({ webhookUrl: data.webhook_url, integrationId: data.integration_id })
						setStep(1)
					}
				},
			},
		)
	}

	const handleCopy = () => {
		if (!manual) return
		navigator.clipboard.writeText(manual.webhookUrl)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	const handleComplete = () => {
		if (!manual || !canWrite) return
		complete.mutate(
			{ id: manual.integrationId, secret },
			{
				onSuccess: handleClose,
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Connect Skjald</DialogTitle>
					<DialogDescription>
						{step === 'app'
							? 'Skjald connects from its own app.'
							: step === 1
								? 'Set up a webhook in Skjald pointing at this URL.'
								: 'Paste the secret Skjald generated to finish connecting.'}
					</DialogDescription>
				</DialogHeader>
				{step === 'app' ? (
					<div className="space-y-3">
						<ol className="list-decimal list-inside space-y-1.5 text-sm text-muted-foreground">
							{SKJALD_APP_STEPS.map((instruction) => (
								<li key={instruction}>{instruction}</li>
							))}
						</ol>
						<div className="flex justify-end gap-2">
							<Button
								variant="ghost"
								onClick={handleManual}
								disabled={connect.isPending || !canWrite}
							>
								Set up manually
							</Button>
							<Button onClick={handleClose}>Done</Button>
						</div>
					</div>
				) : step === 1 ? (
					<div className="space-y-3">
						<div className="space-y-2">
							<Label>Webhook URL</Label>
							<div className="flex gap-2">
								<div className="flex-1 min-w-0 rounded-md border border-border bg-bg-surface px-3 py-2 font-mono text-xs break-all select-all">
									{manual?.webhookUrl}
								</div>
								<Button variant="secondary" size="sm" className="shrink-0" onClick={handleCopy}>
									{copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
								</Button>
							</div>
						</div>
						<ol className="list-decimal list-inside space-y-1.5 text-xs text-muted-foreground">
							{SKJALD_SETUP_STEPS.map((instruction) => (
								<li key={instruction}>{instruction}</li>
							))}
						</ol>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={handleClose}>
								Cancel
							</Button>
							<Button onClick={() => setStep(2)}>Next</Button>
						</div>
					</div>
				) : (
					<div className="space-y-3">
						<div className="space-y-2">
							<Label htmlFor="skjald-secret">Webhook secret</Label>
							<Input
								id="skjald-secret"
								type="password"
								value={secret}
								onChange={(e) => setSecret(e.target.value)}
								placeholder="Paste the secret from Skjald"
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button variant="ghost" onClick={() => setStep(1)}>
								Back
							</Button>
							<Button
								onClick={handleComplete}
								disabled={!secret.trim() || complete.isPending || !canWrite}
							>
								Connect
							</Button>
						</div>
					</div>
				)}
			</DialogContent>
		</Dialog>
	)
}

/** GitHub only lists orgs that already have the Maskin App, so an org without it
 *  can never show up in either picker. This sends the user to the App's install
 *  page; the callback then binds the new installation to this workspace. */
export function InstallGithubOrgButton({
	workspaceId,
	returnTo,
}: {
	workspaceId: string
	returnTo?: string
}) {
	const connect = useConnectIntegration(workspaceId)
	const canWrite = useCanWrite()
	return (
		<ViewerTooltip className="flex w-full md:flex-1">
			<Button
				variant="outline"
				size="sm"
				className="w-full md:flex-1"
				onClick={() => connect.mutate({ provider: 'github', installNewOrg: true, returnTo })}
				disabled={connect.isPending || !canWrite}
			>
				<Plus className="h-3.5 w-3.5 mr-1" />
				Install on another organization
			</Button>
		</ViewerTooltip>
	)
}

export function InstallGithubOrgSection({
	workspaceId,
	returnTo,
}: {
	workspaceId: string
	returnTo?: string
}) {
	return (
		<div className="space-y-2 border-t border-border pt-3">
			<p className="text-xs text-muted-foreground">
				Don&apos;t see your organization? Install the Maskin GitHub App on it first. You&apos;ll
				come back with it connected.
			</p>
			<InstallGithubOrgButton workspaceId={workspaceId} returnTo={returnTo} />
		</div>
	)
}

/** Bind a GitHub App installation the actor already reaches from one of their
 *  other workspaces. GitHub refuses to re-run its install flow for an org that
 *  already has the App, so this is the only path to a second workspace. */
export function LinkGithubDialog({
	workspaceId,
	open,
	onClose,
	returnTo,
}: {
	workspaceId: string
	open: boolean
	onClose: () => void
	/** Where "install on another organization" should land afterwards. */
	returnTo?: string
}) {
	const { data, isLoading } = useLinkableGithubInstallations(workspaceId)
	const link = useLinkGithubInstallation(workspaceId)
	const canWrite = useCanWrite()
	const options = (data ?? []).filter((installation) => !installation.alreadyLinked)

	return (
		<Dialog open={open} onOpenChange={(next) => !next && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add an existing GitHub organization</DialogTitle>
					<DialogDescription>
						These organizations already have the Maskin GitHub App installed from another of your
						workspaces. Adding one here reuses that installation — nothing changes on GitHub.
					</DialogDescription>
				</DialogHeader>
				{isLoading ? (
					<ListSkeleton />
				) : options.length === 0 ? (
					<EmptyState
						title="Nothing to add"
						description="Every organization you've connected is already in this workspace"
					/>
				) : (
					<div className="space-y-2">
						{options.map((installation) => (
							<div
								key={installation.installationId}
								className="flex items-center gap-3 rounded-md border border-border bg-bg-surface p-3"
							>
								<div className="min-w-0 flex-1">
									<p className="truncate text-sm font-medium text-foreground">
										{installation.ownerLogin ?? `Installation ${installation.installationId}`}
									</p>
									<p className="truncate text-xs text-muted-foreground">
										Installation {installation.installationId}
									</p>
								</div>
								<Button
									size="sm"
									className="shrink-0"
									onClick={() =>
										link.mutate(installation.installationId, {
											onSuccess: () => {
												if (options.length === 1) onClose()
											},
										})
									}
									disabled={link.isPending || !canWrite}
								>
									Add
								</Button>
							</div>
						))}
					</div>
				)}
				<InstallGithubOrgSection workspaceId={workspaceId} returnTo={returnTo} />
				<div className="flex justify-end">
					<Button variant="ghost" onClick={onClose}>
						Done
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
