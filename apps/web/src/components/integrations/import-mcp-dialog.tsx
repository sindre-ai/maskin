import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import type { CustomMcpServerSpec } from '@/lib/api'
import { useState } from 'react'

/** The servers in a pasted .mcp.json, or an error message to show. */
export function parseMcpJson(
	json: string,
): { servers: Record<string, CustomMcpServerSpec> } | { error: string } {
	try {
		const parsed = JSON.parse(json)
		const servers = parsed?.mcpServers
		if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
			return { error: 'Expected { "mcpServers": { ... } } format' }
		}
		return { servers: servers as Record<string, CustomMcpServerSpec> }
	} catch {
		return { error: 'Invalid JSON' }
	}
}

export function ImportMcpDialog({
	open,
	saving = false,
	error,
	onClose,
	onImport,
}: {
	open: boolean
	saving?: boolean
	/** A failure from adding the servers, shown under the paste box. */
	error?: string | null
	onClose: () => void
	onImport: (servers: Record<string, CustomMcpServerSpec>) => void
}) {
	const [json, setJson] = useState('')
	const [parseError, setParseError] = useState<string | null>(null)

	const close = () => {
		setJson('')
		setParseError(null)
		onClose()
	}

	const handleImport = () => {
		const result = parseMcpJson(json)
		if ('error' in result) {
			setParseError(result.error)
			return
		}
		setParseError(null)
		onImport(result.servers)
	}

	const shown = parseError ?? error

	return (
		<Dialog open={open} onOpenChange={(v) => !v && close()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Import .mcp.json</DialogTitle>
					<DialogDescription>
						Paste the contents of a .mcp.json file. Each server is added to the workspace; choose
						which agents get it afterwards.
					</DialogDescription>
				</DialogHeader>
				<Textarea
					value={json}
					onChange={(e) => setJson(e.target.value)}
					placeholder={
						'{\n  "mcpServers": {\n    "server-name": {\n      "command": "npx",\n      "args": ["-y", "package-name"],\n      "env": {}\n    }\n  }\n}'
					}
					className="min-h-[200px] font-mono text-sm"
				/>
				{shown && <p className="text-xs text-error">{shown}</p>}
				<div className="flex justify-end gap-2">
					<Button variant="ghost" onClick={close} disabled={saving}>
						Cancel
					</Button>
					<Button onClick={handleImport} disabled={!json.trim() || saving}>
						Import
					</Button>
				</div>
			</DialogContent>
		</Dialog>
	)
}
