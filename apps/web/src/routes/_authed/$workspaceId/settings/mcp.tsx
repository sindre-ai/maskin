import { McpConnectionSection } from '@/components/settings/mcp-connection'
import { RouteError } from '@/components/shared/route-error'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { getApiKey } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy } from 'lucide-react'
import { useState } from 'react'

export const Route = createFileRoute('/_authed/$workspaceId/settings/mcp')({
	component: McpPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
})

function McpPage() {
	const { workspaceId } = useWorkspace()

	return (
		<div className="max-w-lg space-y-6">
			<McpConnectionSection workspaceId={workspaceId} />

			<div className="border-t border-border pt-6">
				<ApiKeySection />
			</div>
		</div>
	)
}

function ApiKeySection() {
	const apiKey = getApiKey()
	const [copied, setCopied] = useState(false)

	const handleCopy = async () => {
		if (!apiKey) return
		await navigator.clipboard.writeText(apiKey)
		setCopied(true)
		setTimeout(() => setCopied(false), 2000)
	}

	if (!apiKey) return null

	return (
		<div>
			<Label className="mb-1 text-muted-foreground">API key</Label>
			<div className="flex items-center gap-2">
				<code className="flex-1 rounded-md border border-border bg-muted px-3 py-2 text-sm font-mono truncate select-all">
					{apiKey}
				</code>
				<Button variant="outline" size="icon" onClick={handleCopy}>
					{copied ? <Check size={16} /> : <Copy size={16} />}
				</Button>
			</div>
		</div>
	)
}
