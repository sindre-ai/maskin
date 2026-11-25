import {
	ConnectionList,
	filterGrants,
	sortNewestFirst,
} from '@/components/settings/claude-connection'
import { Steps } from '@/components/settings/mcp-steps'
import { CodeBlock } from '@/components/shared/code-block'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useOauthGrants } from '@/hooks/use-oauth'
import { trackEvent } from '@/lib/analytics'
import { MCP_OAUTH_CHATGPT_CLIENT_ID } from '@maskin/shared'
import { TriangleAlert } from 'lucide-react'

// The ChatGPT tab of Settings > MCP: the server URL, the steps for adding it as a custom MCP server in
// ChatGPT, and the list of ChatGPT connections with Disconnect (docs/reference/mcp-oauth.md). The grants
// list is the one the Claude tab reads, narrowed to ChatGPT's pinned client.

/** What the tab strip needs: whether the ChatGPT tab reads Connected. */
export function useChatGptConnected() {
	const grants = useOauthGrants()
	return filterGrants(grants.data, MCP_OAUTH_CHATGPT_CLIENT_ID).length > 0
}

function ChatGptNotice({ onRetry }: { onRetry: () => void }) {
	return (
		<div
			role="alert"
			className="flex items-start gap-2.5 rounded-lg border border-ask-border bg-ask-surface px-3.5 py-3 text-[12.5px] leading-[1.55] text-foreground"
		>
			<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
			<span className="min-w-0 flex-1">We couldn't check whether ChatGPT is connected.</span>
			<Button type="button" variant="outline" size="xs" onClick={onRetry}>
				Try again
			</Button>
		</div>
	)
}

export function ChatGptTabPanel({ mcpUrl }: { mcpUrl: string }) {
	const grants = useOauthGrants()

	if (grants.isPending) {
		return (
			<div className="space-y-3">
				<output className="sr-only">Checking your connection...</output>
				<Skeleton className="h-16 w-full" />
			</div>
		)
	}

	const rows = sortNewestFirst(filterGrants(grants.data, MCP_OAUTH_CHATGPT_CLIENT_ID))
	if (rows.length > 0) {
		return <ConnectionList rows={rows} appName="ChatGPT" />
	}

	return (
		<div className="space-y-4">
			{grants.isError && <ChatGptNotice onRetry={() => grants.refetch()} />}
			<Steps
				steps={[
					'In ChatGPT on the web, open Plugins, click the plus button, then choose Add custom MCP server.',
					'Enter the name Maskin. Under Connection, paste the server URL below.',
					'Set authentication to OAuth, tick I understand and want to continue, then click Create as a plugin.',
					'Install the plugin and sign in to Maskin when ChatGPT asks. You choose the workspace it can use.',
				]}
			/>
			<CodeBlock
				label="Server URL"
				text={mcpUrl}
				toastMessage="Server URL copied"
				onCopy={() => trackEvent('mcp_copy', { tab: 'chatgpt' })}
			/>
			<p className="text-xs text-muted-foreground">
				No key to paste. ChatGPT sends you to Maskin to sign in, and you choose which workspace it
				can use.
			</p>
			<p className="text-xs text-muted-foreground">
				Don't see Add custom MCP server? Your ChatGPT plan or your ChatGPT admin may not allow it.
			</p>
		</div>
	)
}
