import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
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
import {
	useAddToolBrokerIntegration,
	useConnectToolBrokerIntegration,
	useDisconnectToolBrokerIntegration,
	useToolBrokerIntegrations,
} from '@/hooks/use-tool-broker'
import type { ToolBrokerIntegration } from '@/lib/api'
import { Plug, Plus } from 'lucide-react'
import { useState } from 'react'

// The tool-broker half of the integrations page: integrations added by URL,
// rather than the hand-built OAuth providers listed below it. Composed entirely
// from existing primitives and shared components — no new ones.

export function ToolBrokerSection({ workspaceId }: { workspaceId: string }) {
	const { data, isLoading } = useToolBrokerIntegrations(workspaceId)
	const [addOpen, setAddOpen] = useState(false)

	// Not configured for this deployment: render nothing at all rather than an
	// empty section that suggests something is broken.
	if (!isLoading && data && !data.configured) return null

	return (
		<section className="space-y-3" aria-labelledby="tool-broker-heading">
			<div className="flex items-center justify-between gap-2">
				<div>
					<h2 id="tool-broker-heading" className="font-medium text-sm">
						Connected by URL
					</h2>
					<p className="text-text-secondary text-xs">
						Point at an MCP server or an OpenAPI spec to give your agents its tools.
					</p>
				</div>
				<Button size="sm" onClick={() => setAddOpen(true)}>
					<Plus className="size-4" />
					Add
				</Button>
			</div>

			{isLoading ? (
				<ListSkeleton />
			) : !data?.available ? (
				<EmptyState
					title="Integrations are unavailable"
					description="The integration service can't be reached right now. Your agents keep working; these tools are temporarily missing."
				/>
			) : data.integrations.length === 0 ? (
				<EmptyState
					icon={<Plug className="size-5" />}
					title="No integrations yet"
					description="Add an MCP server or OpenAPI spec by URL to get started."
					action={
						<Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
							Add integration
						</Button>
					}
				/>
			) : (
				<ul className="space-y-2">
					{data.integrations.map((integration) => (
						<IntegrationRow
							key={integration.slug}
							integration={integration}
							workspaceId={workspaceId}
						/>
					))}
				</ul>
			)}

			<AddIntegrationDialog open={addOpen} onOpenChange={setAddOpen} workspaceId={workspaceId} />
		</section>
	)
}

function IntegrationRow({
	integration,
	workspaceId,
}: { integration: ToolBrokerIntegration; workspaceId: string }) {
	const connect = useConnectToolBrokerIntegration(workspaceId)
	const disconnect = useDisconnectToolBrokerIntegration(workspaceId)

	// OAuth first when the provider offers it: it is the only one that yields a
	// real user-scoped credential. The ellipsis on the label warns that the click
	// leaves Maskin for the provider's consent screen.
	const auth: { type: 'oauth' } | { type: 'none' } = integration.authKinds.includes('oauth')
		? { type: 'oauth' }
		: { type: 'none' }

	return (
		<li className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
			<div className="min-w-0">
				<p className="truncate font-medium text-sm">{integration.name}</p>
				<p className="truncate text-text-secondary text-xs">
					{integration.url ?? integration.kind.toUpperCase()}
				</p>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				{/* Connected is the load-bearing distinction: an integration can be
				    present in the workspace and still have no callable tools. */}
				<span className="text-text-secondary text-xs" data-testid="connection-state">
					{integration.connected ? 'Connected' : 'Not connected'}
				</span>
				{integration.connected ? (
					<Button
						size="sm"
						variant="outline"
						disabled={disconnect.isPending}
						onClick={() => disconnect.mutate(integration.slug)}
					>
						Disconnect
					</Button>
				) : (
					<Button
						size="sm"
						disabled={connect.isPending}
						onClick={() => connect.mutate({ slug: integration.slug, auth })}
					>
						{auth.type === 'oauth' ? 'Connect…' : 'Connect'}
					</Button>
				)}
			</div>
		</li>
	)
}

function AddIntegrationDialog({
	open,
	onOpenChange,
	workspaceId,
}: { open: boolean; onOpenChange: (open: boolean) => void; workspaceId: string }) {
	const [url, setUrl] = useState('')
	const [name, setName] = useState('')
	const add = useAddToolBrokerIntegration(workspaceId)

	// An MCP endpoint and an OpenAPI document are registered differently, and the
	// URL alone does not say which it is — so infer from the shape and let the
	// user see what was inferred rather than asking them to classify it.
	const kind: 'mcp' | 'openapi' = /\.(json|ya?ml)(\?|$)/i.test(url) ? 'openapi' : 'mcp'

	const submit = () => {
		if (!url.trim()) return
		add.mutate(
			{ url: url.trim(), kind, name: name.trim() || undefined },
			{
				onSuccess: () => {
					setUrl('')
					setName('')
					onOpenChange(false)
				},
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add integration</DialogTitle>
					<DialogDescription>
						Give the URL of an MCP server or an OpenAPI spec. Its tools become available to your
						agents once you connect it.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-3">
					<div className="space-y-1.5">
						<Label htmlFor="tool-broker-url">URL</Label>
						<Input
							id="tool-broker-url"
							value={url}
							onChange={(event) => setUrl(event.target.value)}
							placeholder="https://mcp.example.com/mcp"
							autoComplete="off"
						/>
						{url.trim() ? (
							<p className="text-text-secondary text-xs">
								Detected as {kind === 'openapi' ? 'an OpenAPI spec' : 'an MCP server'}.
							</p>
						) : null}
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="tool-broker-name">Name (optional)</Label>
						<Input
							id="tool-broker-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Example"
							autoComplete="off"
						/>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={submit} disabled={!url.trim() || add.isPending}>
						{add.isPending ? 'Adding…' : 'Add'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
