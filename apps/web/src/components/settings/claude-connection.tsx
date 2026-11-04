import { Steps } from '@/components/settings/mcp-steps'
import { CodeBlock } from '@/components/shared/code-block'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import {
	ResponsiveDialog,
	ResponsiveDialogContent,
	ResponsiveDialogDescription,
	ResponsiveDialogFooter,
	ResponsiveDialogHeader,
	ResponsiveDialogTitle,
} from '@/components/ui/responsive-dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { useFeatureFlag } from '@/hooks/use-feature-flag'
import { useDisconnectGrant, useOauthGrants } from '@/hooks/use-oauth'
import { trackEvent } from '@/lib/analytics'
import type { OauthGrantRow } from '@maskin/shared'
import { TriangleAlert } from 'lucide-react'
import { useState } from 'react'

// The Claude tab of Settings > MCP: the real "Add to Claude" link and the list of Claude connections with
// Disconnect (docs/reference/mcp-oauth.md). The tab shows when the connector flag is on for the person or when
// they already have a connection, so the only revoke button never disappears with the flag.

export const MCP_OAUTH_FLAG = 'mcp-oauth-consent'

/** Claude's own prefilled "add custom connector" form: name and server URL filled in, no key or secret in it. */
export function buildAddToClaudeUrl(mcpUrl: string): string {
	const url = new URL('https://claude.ai/customize/connectors')
	url.searchParams.set('modal', 'add-custom-connector')
	url.searchParams.set('connectorName', 'Maskin')
	url.searchParams.set('connectorUrl', mcpUrl)
	return url.toString()
}

/** What the tab strip needs: whether to show the Claude tab, and whether it reads Connected. */
export function useClaudeTab() {
	const flagOn = useFeatureFlag(MCP_OAUTH_FLAG)
	const grants = useOauthGrants()
	const connected = (grants.data?.length ?? 0) > 0
	return { visible: flagOn || connected, connected }
}

function formatConnectedDate(iso: string): string {
	return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

function ClaudeNotice({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="flex items-start gap-2.5 rounded-lg border border-ask-border bg-ask-surface px-3.5 py-3 text-[12.5px] leading-[1.55] text-foreground"
		>
			<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
			<span className="min-w-0 flex-1">We couldn't check whether Claude is connected.</span>
			<Button type="button" variant="outline" size="xs" onClick={onRetry}>
				Try again
			</Button>
		</div>
	)
}

function AddToClaude({ mcpUrl }: { mcpUrl: string }) {
	return (
		<>
			<Steps
				steps={[
					'Click Add to Claude. The connector form opens with the name and URL filled in.',
					'Click Add, then Connect. Sign in to Maskin when Claude asks.',
				]}
			/>
			<Button asChild>
				<a
					href={buildAddToClaudeUrl(mcpUrl)}
					target="_blank"
					rel="noopener noreferrer"
					onClick={() => trackEvent('mcp_add_click', { tab: 'claude' })}
				>
					Add to Claude
				</a>
			</Button>
			<p className="text-xs text-muted-foreground">
				On a Team or Enterprise plan? Ask your Claude admin to add Maskin, then click Connect.
			</p>
			<p className="text-xs text-muted-foreground">
				No key to paste. Claude signs in with your Maskin account, and you choose which workspace it
				can use.
			</p>
			<div className="space-y-3 border-t border-border-subtle pt-4">
				<p className="text-[13px] font-semibold text-foreground">Or add it manually</p>
				<Steps
					steps={[
						'In Claude, open Customize, then Connectors, then Add custom connector.',
						'Paste this server URL, click Add, then click Connect and sign in to Maskin when Claude asks.',
					]}
				/>
				<CodeBlock
					label="Server URL"
					text={mcpUrl}
					toastMessage="Server URL copied"
					onCopy={() => trackEvent('mcp_copy', { tab: 'claude' })}
				/>
			</div>
		</>
	)
}

function ConnectionRow({
	grant,
	onDisconnect,
}: { grant: OauthGrantRow; onDisconnect: (grant: OauthGrantRow) => void }) {
	return (
		<li className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3.5 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 items-center gap-3">
				<div
					aria-hidden="true"
					className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-subtle text-sm font-semibold text-brand-subtle-foreground"
				>
					{grant.client_name.charAt(0).toUpperCase()}
				</div>
				<div className="min-w-0">
					<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span className="text-sm font-semibold text-foreground">{grant.client_name}</span>
						<span className="rounded-md bg-status-live-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-status-live-text">
							Connected
						</span>
					</div>
					<p className="truncate text-xs text-muted-foreground">
						Workspace: {grant.workspace_name}
					</p>
					<p className="text-xs text-muted-foreground">
						Connected {formatConnectedDate(grant.created_at)}
						{grant.last_used_at && (
							<span className="whitespace-nowrap">
								{' · '}Last used <RelativeTime date={grant.last_used_at} />
							</span>
						)}
					</p>
				</div>
			</div>
			<Button
				type="button"
				variant="outline"
				className="w-full sm:w-auto"
				onClick={() => onDisconnect(grant)}
			>
				Disconnect
			</Button>
		</li>
	)
}

function DisconnectDialog({
	grant,
	onClose,
}: { grant: OauthGrantRow | null; onClose: () => void }) {
	const disconnect = useDisconnectGrant()
	const close = () => {
		disconnect.reset()
		onClose()
	}
	return (
		<ResponsiveDialog
			open={grant !== null}
			onOpenChange={(open) => {
				if (!open && !disconnect.isPending) close()
			}}
		>
			<ResponsiveDialogContent>
				<ResponsiveDialogHeader>
					<ResponsiveDialogTitle>Disconnect Claude?</ResponsiveDialogTitle>
					<ResponsiveDialogDescription>
						Claude loses access to Maskin right away. Claude may then show "connection expired". You
						can connect it again any time.
					</ResponsiveDialogDescription>
				</ResponsiveDialogHeader>
				{disconnect.isError && (
					<p role="alert" className="text-xs text-error">
						We couldn't disconnect Claude. Try again.
					</p>
				)}
				<ResponsiveDialogFooter>
					<Button type="button" variant="outline" disabled={disconnect.isPending} onClick={close}>
						Cancel
					</Button>
					<Button
						type="button"
						variant="destructive"
						disabled={disconnect.isPending}
						onClick={() => grant && disconnect.mutate(grant.id, { onSuccess: close })}
					>
						{disconnect.isPending ? 'Disconnecting...' : 'Disconnect'}
					</Button>
				</ResponsiveDialogFooter>
			</ResponsiveDialogContent>
		</ResponsiveDialog>
	)
}

export function ClaudeTabPanel({ mcpUrl }: { mcpUrl: string }) {
	const flagOn = useFeatureFlag(MCP_OAUTH_FLAG)
	const grants = useOauthGrants()
	const [target, setTarget] = useState<OauthGrantRow | null>(null)

	if (grants.isPending) {
		return (
			<div className="space-y-3">
				<output className="sr-only">Checking your connection...</output>
				<Skeleton className="h-16 w-full" />
			</div>
		)
	}

	// Newest connection first.
	const rows = [...(grants.data ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))

	if (rows.length > 0) {
		return (
			<div className="space-y-3">
				<ul className="space-y-2">
					{rows.map((grant) => (
						<ConnectionRow key={grant.id} grant={grant} onDisconnect={setTarget} />
					))}
				</ul>
				{rows.length > 1 && (
					<p className="text-xs text-muted-foreground">
						One row per workspace. Connecting Claude again to the same workspace replaces the old
						connection.
					</p>
				)}
				<p className="text-xs text-muted-foreground">
					Claude acts as you, with your access in the workspace shown. Disconnect to end it right
					away. Removing Maskin inside Claude may not end access. Disconnect here too.
				</p>
				{!flagOn && (
					<p className="text-xs text-muted-foreground">
						Adding new Claude connections is switched off for now. Existing ones keep working until
						you disconnect them.
					</p>
				)}
				<DisconnectDialog grant={target} onClose={() => setTarget(null)} />
			</div>
		)
	}

	return (
		<div className="space-y-4">
			{grants.isError && <ClaudeNotice onRetry={() => grants.refetch()} />}
			<AddToClaude mcpUrl={mcpUrl} />
		</div>
	)
}
