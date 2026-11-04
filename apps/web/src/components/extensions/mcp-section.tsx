import { McpDialog } from '@/components/extensions/mcp-dialog'
import { formFromMcpConfig, mcpToolCount } from '@/components/extensions/mcp-form'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { MaskedSecret } from '@/components/ui/masked-secret'
import { useCanWrite } from '@/hooks/use-can-write'
import type { ExtensionMcpConfig, ExtensionResponse, VendorRecipe } from '@/lib/api'
import { cn } from '@/lib/cn'
import { mcpRemoteUrl } from '@maskin/shared'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'

/** MCP half of the detail page: add button when empty, saved summary with Edit when wired. */
export function McpSection({
	ext,
	workspaceId,
	recipes,
}: { ext: ExtensionResponse; workspaceId: string; recipes: VendorRecipe[] }) {
	const canWrite = useCanWrite()
	const [open, setOpen] = useState(false)
	const [dialogKey, setDialogKey] = useState(0)
	const [initialUrl, setInitialUrl] = useState<string | undefined>()
	const cfg = ext.mcpConfig as ExtensionMcpConfig | null
	const recipe = recipes.find((r) => r.slug === ext.slug && r.mcpConfig)
	const recipeUrl = recipe?.mcpConfig
		? mcpRemoteUrl(recipe.mcpConfig.server as { type: string; command?: string; args?: string[] })
		: null

	const openDialog = (url?: string) => {
		if (!canWrite) return
		setInitialUrl(url)
		setDialogKey((k) => k + 1)
		setOpen(true)
	}

	return (
		<section className="rounded-xl border border-border bg-card p-4" aria-labelledby="mcp-heading">
			<div className="flex items-start justify-between gap-3">
				<div>
					<div className="flex items-center gap-2">
						<h2 id="mcp-heading" className="text-[13px] font-bold">
							MCP tools
						</h2>
						{cfg && (
							<Badge variant={ext.mcpLastError ? 'outline' : 'live'}>
								{ext.mcpLastError ? 'Not attached' : `On · ${mcpToolCount(ext)} tools`}
							</Badge>
						)}
					</div>
					<p className="text-xs text-muted-foreground">
						Agents call this vendor's tools. Server + auth.
					</p>
				</div>
				{cfg ? (
					<ViewerTooltip>
						<Button variant="secondary" size="sm" disabled={!canWrite} onClick={() => openDialog()}>
							Edit
						</Button>
					</ViewerTooltip>
				) : (
					<ViewerTooltip>
						<Button
							size="sm"
							disabled={!canWrite}
							onClick={() => openDialog(recipeUrl ?? undefined)}
						>
							{recipe ? `Add MCP from the ${recipe.displayName} recipe` : 'Add MCP'}
						</Button>
					</ViewerTooltip>
				)}
			</div>

			{ext.mcpLastError && (
				<div
					role="alert"
					className="mt-3 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning"
				>
					<AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
					<p className="flex-1">
						This MCP is not attached to sessions: {ext.mcpLastError}.{' '}
						<ViewerTooltip>
							<button
								type="button"
								className="underline disabled:cursor-not-allowed disabled:no-underline"
								disabled={!canWrite}
								onClick={() => openDialog()}
							>
								Fix it in the MCP step
							</button>
						</ViewerTooltip>
					</p>
				</div>
			)}

			{cfg && (
				<div className="mt-4 grid gap-3">
					<div className="grid gap-1.5">
						<span className="text-xs text-muted-foreground">Server URL</span>
						<code className="block min-w-0 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
							{formFromMcpConfig(ext).serverUrl}
						</code>
					</div>
					{cfg.server.type === 'stdio' && cfg.server.envFromCredential && (
						<div className="grid gap-1.5">
							<span className="text-xs text-muted-foreground">API key</span>
							{ext.hasMcpKey ? (
								<MaskedSecret aria-label="API key (hidden)" />
							) : (
								<p className="text-xs text-warning">No key stored. Edit to add one.</p>
							)}
						</div>
					)}
					<ul className="flex flex-wrap gap-1.5" aria-label="Tools">
						{cfg.tools.map((t) => (
							<li
								key={t.name}
								className={cn(
									'rounded-md border px-1.5 py-0.5 font-mono text-[11px]',
									t.kind === 'write'
										? 'border-warning/40 bg-warning/10 text-warning'
										: 'border-border text-muted-foreground',
								)}
							>
								{t.name}
								<span className="sr-only"> ({t.kind})</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{open && (
				<McpDialog
					key={dialogKey}
					ext={ext}
					workspaceId={workspaceId}
					initialUrl={initialUrl}
					open={open}
					onOpenChange={setOpen}
				/>
			)}
		</section>
	)
}
