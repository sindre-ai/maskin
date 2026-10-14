import { CodeBlock } from '@/components/shared/code-block'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { trackEvent } from '@/lib/analytics'
import { getApiKey } from '@/lib/auth'
import { TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

type Tab = 'claude-code' | 'cursor' | 'vscode' | 'claude-desktop' | 'other'

// The Claude tab is not here yet: it arrives with the OAuth consent page.
const tabs: { value: Tab; label: string }[] = [
	{ value: 'claude-code', label: 'Claude Code' },
	{ value: 'cursor', label: 'Cursor' },
	{ value: 'vscode', label: 'VS Code' },
	{ value: 'claude-desktop', label: 'Claude Desktop' },
	{ value: 'other', label: 'Other' },
]

const KEY_PLACEHOLDER = '<API_KEY>'

function getMcpUrl() {
	return `${window.location.origin}/mcp`
}

function buildHeaders(apiKey: string, workspaceId: string) {
	return { Authorization: `Bearer ${apiKey}`, 'X-Workspace-Id': workspaceId }
}

/** Cursor install link: the server entry as JSON, base64-encoded in the config parameter. */
function buildCursorLink(mcpUrl: string, apiKey: string, workspaceId: string) {
	const config = JSON.stringify({ url: mcpUrl, headers: buildHeaders(apiKey, workspaceId) })
	return `cursor://anysphere.cursor-deeplink/mcp/install?name=maskin&config=${btoa(config)}`
}

/** VS Code install link: the server entry (with its name) as URL-encoded JSON. */
function buildVsCodeLink(mcpUrl: string, apiKey: string, workspaceId: string) {
	const config = JSON.stringify({
		name: 'maskin',
		type: 'http',
		url: mcpUrl,
		headers: buildHeaders(apiKey, workspaceId),
	})
	return `vscode:mcp/install?${encodeURIComponent(config)}`
}

interface Block {
	label: string
	fileName?: boolean
	text: string
	/** True when the text holds the API key: Copy is off without a key, and the toast says so. */
	holdsKey: boolean
}

interface Panel {
	steps: string[]
	add?: { label: string; buildLink: (apiKey: string) => string }
	blocks: Block[]
	note?: string
}

function buildPanels(mcpUrl: string, apiKey: string, workspaceId: string) {
	const headers = buildHeaders(apiKey, workspaceId)
	const headerArgs = [
		'--header',
		`Authorization: ${headers.Authorization}`,
		'--header',
		`X-Workspace-Id: ${workspaceId}`,
	]
	const json = (value: unknown) => JSON.stringify(value, null, 2)

	const panels: Record<Tab, Panel> = {
		'claude-code': {
			steps: [
				'Run this command in your terminal.',
				'Run /mcp inside Claude Code to check that maskin is connected.',
			],
			blocks: [
				{
					label: 'Terminal',
					text: `claude mcp add --transport http maskin ${mcpUrl} --header "Authorization: ${headers.Authorization}" --header "X-Workspace-Id: ${workspaceId}"`,
					holdsKey: true,
				},
			],
			note: 'Add --scope user to make it available in every project.',
		},
		cursor: {
			steps: [
				'Click Add to Cursor and confirm the install.',
				'Or add the config below to ~/.cursor/mcp.json.',
			],
			add: {
				label: 'Add to Cursor',
				buildLink: (key) => buildCursorLink(mcpUrl, key, workspaceId),
			},
			blocks: [
				{
					label: '~/.cursor/mcp.json',
					fileName: true,
					text: json({ mcpServers: { maskin: { url: mcpUrl, headers } } }),
					holdsKey: true,
				},
			],
		},
		vscode: {
			steps: [
				'Click Add to VS Code, or run this command.',
				'Open Copilot Chat in agent mode and start maskin from the tools menu.',
			],
			add: {
				label: 'Add to VS Code',
				buildLink: (key) => buildVsCodeLink(mcpUrl, key, workspaceId),
			},
			blocks: [
				{
					label: 'Terminal',
					text: `code --add-mcp '${JSON.stringify({ name: 'maskin', type: 'http', url: mcpUrl, headers })}'`,
					holdsKey: true,
				},
			],
			note: 'Needs VS Code 1.99 or later.',
		},
		'claude-desktop': {
			steps: [
				'Open Settings, then Developer, then Edit config.',
				'Add this to claude_desktop_config.json and restart.',
			],
			blocks: [
				{
					label: 'claude_desktop_config.json',
					fileName: true,
					text: json({
						mcpServers: {
							maskin: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, ...headerArgs] },
						},
					}),
					holdsKey: true,
				},
			],
			note: 'Needs Node.js installed.',
		},
		other: {
			steps: [
				'Add a remote MCP server in your app and paste the server URL.',
				'Choose Streamable HTTP if asked for a transport.',
				'Add these two headers to every request.',
			],
			blocks: [
				{ label: 'Server URL', text: mcpUrl, holdsKey: false },
				{
					label: 'Headers',
					text: `Authorization: ${headers.Authorization}\nX-Workspace-Id: ${workspaceId}`,
					holdsKey: true,
				},
			],
			note: 'The Authorization header holds your API key. Keep it private.',
		},
	}
	return panels
}

function NoKeyNotice() {
	return (
		<div
			role="alert"
			className="flex items-start gap-2.5 rounded-lg border border-ask-border bg-ask-surface px-3.5 py-3 text-[12.5px] leading-[1.55] text-foreground"
		>
			<TriangleAlert size={14} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
			<span>
				We couldn't find an API key for this session, so the config below has a placeholder. Sign
				out and back in, then reopen this page.
			</span>
		</div>
	)
}

function Steps({ steps }: { steps: string[] }) {
	return (
		<ol className="space-y-2">
			{steps.map((step, i) => (
				<li key={step} className="flex items-baseline gap-[11px]">
					<span
						aria-hidden="true"
						className="grid size-5 flex-none -translate-y-px place-items-center rounded-full bg-muted font-mono text-[10.5px] font-bold text-muted-foreground"
					>
						{i + 1}
					</span>
					<span className="min-w-0 text-[13px] leading-[1.55] text-foreground [text-wrap:pretty]">
						{step}
					</span>
				</li>
			))}
		</ol>
	)
}

export function McpConnectionSection({ workspaceId }: { workspaceId: string }) {
	const [activeTab, setActiveTab] = useState<Tab>('claude-code')
	const listRef = useRef<HTMLDivElement>(null)

	// getApiKey is read on each render and again at click time for the install links, so the
	// key is never held in state and never rendered into an href.
	const storedKey = getApiKey()
	const hasKey = !!storedKey
	const mcpUrl = getMcpUrl()
	const panels = buildPanels(mcpUrl, storedKey ?? KEY_PLACEHOLDER, workspaceId)
	const panel = panels[activeTab]

	// On a narrow screen the strip scrolls; keep the selected tab in view so the next one peeks out.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the active tab changes
	useEffect(() => {
		listRef.current
			?.querySelector('[data-state="active"]')
			?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' })
	}, [activeTab])

	const handleAdd = () => {
		const key = getApiKey()
		if (!key || !panel.add) return
		trackEvent('mcp_add_click', { tab: activeTab })
		window.location.assign(panel.add.buildLink(key))
	}

	return (
		<div className="w-full max-w-[1000px]">
			<h2 className="text-lg font-semibold tracking-tight">Use Maskin in other apps</h2>
			<p className="mt-1 text-sm text-muted-foreground">
				Add this workspace as an MCP server in Claude, Cursor or any client that supports MCP.
			</p>

			<div className="settings-label mt-6 mb-2">Add it to your app</div>
			<div className="overflow-hidden rounded-xl border border-border">
				<Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as Tab)}>
					<TabsList ref={listRef} variant="line" aria-label="App" className="px-2">
						{tabs.map((tab) => (
							<TabsTrigger key={tab.value} value={tab.value}>
								{tab.label}
							</TabsTrigger>
						))}
					</TabsList>
					<TabsContent value={activeTab} className="mt-0 space-y-4 p-4">
						{!hasKey && <NoKeyNotice />}
						<Steps steps={panel.steps} />
						{panel.add && (
							<Button type="button" disabled={!hasKey} onClick={handleAdd}>
								{panel.add.label}
							</Button>
						)}
						{panel.blocks.map((block) => (
							<CodeBlock
								key={block.label}
								label={block.label}
								fileName={block.fileName}
								text={block.text}
								toastMessage={block.holdsKey ? 'Copied with your API key' : 'Server URL copied'}
								copyDisabled={block.holdsKey && !hasKey}
								onCopy={() => trackEvent('mcp_copy', { tab: activeTab })}
							/>
						))}
						{panel.note && <p className="text-xs text-muted-foreground">{panel.note}</p>}
					</TabsContent>
				</Tabs>
			</div>
		</div>
	)
}
