import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { getApiKey } from '@/lib/auth'
import { Check, Copy } from 'lucide-react'

import { useCallback, useMemo, useState } from 'react'

type Tab = 'claude-ai' | 'claude-code' | 'claude-desktop' | 'custom'

const tabs: { value: Tab; label: string }[] = [
	{ value: 'claude-ai', label: 'Claude.ai' },
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'claude-desktop', label: 'Claude Desktop' },
	{ value: 'custom', label: 'Custom' },
]

function getMcpUrl() {
	return `${window.location.origin}/mcp`
}

function getConnectorUrl(mcpUrl: string, apiKey: string, workspaceId: string) {
	return `${mcpUrl}?key=${encodeURIComponent(apiKey)}&workspace=${encodeURIComponent(workspaceId)}`
}

function buildConfig(tab: Tab, mcpUrl: string, apiKey: string, workspaceId: string) {
	if (tab === 'claude-code') {
		return JSON.stringify(
			{
				mcpServers: {
					'ai-native': {
						type: 'http',
						url: mcpUrl,
						headers: {
							Authorization: `Bearer ${apiKey}`,
							'X-Workspace-Id': workspaceId,
						},
					},
				},
			},
			null,
			2,
		)
	}

	if (tab === 'claude-desktop') {
		return JSON.stringify(
			{
				mcpServers: {
					'ai-native': {
						command: 'npx',
						args: [
							'-y',
							'mcp-remote',
							mcpUrl,
							'--header',
							`Authorization: Bearer ${apiKey}`,
							'--header',
							`X-Workspace-Id: ${workspaceId}`,
						],
					},
				},
			},
			null,
			2,
		)
	}

	return null
}

function buildCliCommand(mcpUrl: string, apiKey: string, workspaceId: string) {
	return `claude mcp add --transport http ai-native ${mcpUrl} --header "Authorization: Bearer ${apiKey}" --header "X-Workspace-Id: ${workspaceId}"`
}

function CopyButton({
	text,
	label,
	className,
}: { text: string; label?: boolean; className?: string }) {
	const [copied, setCopied] = useState(false)

	const handleCopy = useCallback(async () => {
		await navigator.clipboard.writeText(text)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}, [text])

	return (
		<Button variant="secondary" size="sm" className={className} onClick={handleCopy}>
			{copied ? (
				<>
					<Check size={14} />
					{label && <span className="ml-1">Copied!</span>}
				</>
			) : (
				<>
					<Copy size={14} />
					{label && <span className="ml-1">Copy</span>}
				</>
			)}
		</Button>
	)
}

export function McpConnectionSection({ workspaceId }: { workspaceId: string }) {
	const [activeTab, setActiveTab] = useState<Tab>('claude-ai')

	const apiKey = getApiKey() ?? 'your-api-key'
	const mcpUrl = getMcpUrl()

	const connectorUrl = useMemo(
		() => getConnectorUrl(mcpUrl, apiKey, workspaceId),
		[mcpUrl, apiKey, workspaceId],
	)

	const configJson = useMemo(
		() => buildConfig(activeTab, mcpUrl, apiKey, workspaceId),
		[activeTab, mcpUrl, apiKey, workspaceId],
	)

	const cliCommand = useMemo(
		() => buildCliCommand(mcpUrl, apiKey, workspaceId),
		[mcpUrl, apiKey, workspaceId],
	)

	return (
		<div>
			<Label>MCP Connection</Label>
			<p className="text-xs text-muted-foreground mb-3">
				Connect Claude.ai, Claude Code, Claude Desktop, or any MCP-compatible client to this
				workspace.
			</p>

			<Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)} className="mb-3">
				<div className="overflow-x-auto">
					<TabsList className="inline-flex w-auto min-w-full">
						{tabs.map((tab) => (
							<TabsTrigger
								key={tab.value}
								value={tab.value}
								className="flex-1 text-xs whitespace-nowrap"
							>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
				</div>
			</Tabs>

			{activeTab === 'claude-ai' ? (
				<div className="space-y-3">
					<div>
						<Label>Custom connector URL</Label>
						<p className="text-xs text-muted-foreground mb-2">
							Go to Profile → Settings → Connectors → Add custom connector, then paste this URL.
						</p>
						<div className="relative">
							<pre className="rounded-md border border-border bg-muted p-3 pr-12 font-mono text-xs overflow-x-auto whitespace-pre break-all">
								{connectorUrl}
							</pre>
							<CopyButton text={connectorUrl} label className="absolute top-2 right-2" />
						</div>
					</div>
				</div>
			) : activeTab === 'custom' ? (
				<div className="space-y-3">
					<div>
						<Label>Endpoint URL</Label>
						<div className="flex gap-2">
							<div className="flex-1 rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs select-all">
								{mcpUrl}
							</div>
							<CopyButton text={mcpUrl} />
						</div>
					</div>
					<div>
						<Label>Required Headers</Label>
						<div className="rounded-md border border-border bg-muted p-3 font-mono text-xs space-y-1">
							<div>
								<span className="text-muted-foreground">Authorization:</span> Bearer {apiKey}
							</div>
							<div>
								<span className="text-muted-foreground">X-Workspace-Id:</span> {workspaceId}
							</div>
						</div>
					</div>
					<p className="text-xs text-muted-foreground">Transport: Streamable HTTP (POST)</p>
				</div>
			) : (
				<div className="space-y-3">
					{activeTab === 'claude-code' && (
						<div>
							<Label>Quick setup (run in terminal)</Label>
							<div className="relative">
								<pre className="rounded-md border border-border bg-muted p-3 pr-12 font-mono text-xs overflow-x-auto whitespace-pre">
									{cliCommand}
								</pre>
								<CopyButton text={cliCommand} className="absolute top-2 right-2" />
							</div>
						</div>
					)}
					<div>
						<Label>
							{activeTab === 'claude-code'
								? 'Or add to .mcp.json / ~/.claude.json'
								: 'Add to claude_desktop_config.json'}
						</Label>
						<div className="relative">
							<pre className="rounded-md border border-border bg-muted p-3 pr-12 font-mono text-xs overflow-x-auto whitespace-pre">
								{configJson}
							</pre>
							<CopyButton text={configJson ?? ''} label className="absolute top-2 right-2" />
						</div>
					</div>
				</div>
			)}
		</div>
	)
}
