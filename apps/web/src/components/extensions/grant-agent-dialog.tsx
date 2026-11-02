import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import type { ExtensionTool } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useState } from 'react'

/**
 * Per-tool grant for one agent on one extension (design spec A, Agent access).
 * Read tools start checked and write tools unchecked unless the agent already
 * has choices stored; the parent seeds that through initial.
 */
export function GrantAgentDialog({
	open,
	onOpenChange,
	agentName,
	extensionName,
	tools,
	initial,
	pending,
	onSubmit,
}: {
	open: boolean
	onOpenChange: (open: boolean) => void
	agentName: string
	extensionName: string
	tools: ExtensionTool[]
	initial: Record<string, boolean>
	pending: boolean
	onSubmit: (selection: Record<string, boolean>) => void
}) {
	const [selection, setSelection] = useState(initial)
	const count = tools.filter((t) => selection[t.name]).length

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[100dvh] overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:h-[100dvh] max-sm:content-start max-sm:w-full max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-none">
				<DialogHeader>
					<DialogTitle>
						Grant {agentName} → {extensionName}
					</DialogTitle>
					<DialogDescription>
						Pick which tools this agent can call. Default: read-only tools only.
					</DialogDescription>
				</DialogHeader>

				<ul className="grid gap-1">
					{tools.map((t) => {
						const id = `grant-tool-${t.name}`
						return (
							<li key={t.name} className="flex items-center gap-3 rounded-lg p-2">
								<Checkbox
									id={id}
									checked={!!selection[t.name]}
									onCheckedChange={(v) => setSelection((s) => ({ ...s, [t.name]: v === true }))}
								/>
								<Label htmlFor={id} className="min-w-0 flex-1 truncate font-mono text-xs">
									{t.name}
								</Label>
								<span
									className={cn(
										'shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px]',
										t.kind === 'write'
											? 'border-warning/40 bg-warning/10 text-warning'
											: 'border-border text-muted-foreground',
									)}
								>
									{t.kind}
								</span>
							</li>
						)
					})}
				</ul>

				<p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
					Write tools are opt-in. Turn on only the ones this agent needs.
				</p>

				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button disabled={pending || count === 0} onClick={() => onSubmit(selection)}>
						Grant {count} {count === 1 ? 'tool' : 'tools'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
