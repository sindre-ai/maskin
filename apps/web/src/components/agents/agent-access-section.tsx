import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { EmptyState } from '@/components/shared/empty-state'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useRevokeToolGrant, useToolGrants, useUpsertToolGrant } from '@/hooks/use-tool-grants'
import type { ActorResponse, ToolGrant, ToolGrantTool } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { ShieldCheck } from 'lucide-react'
import { useMemo, useState } from 'react'

// What this agent may reach, and how much of it.
//
// Separate from the Tools section above, which attaches MCP servers to this
// agent. That one adds capability; this one bounds it — including the credential,
// which is the half that used to leak to every agent regardless.

type Mode = 'all' | 'read' | 'custom'

/** Strip our internal namespacing so nobody reads `w0123…_linear`. */
const displayRef = (ref: string): string => {
	const withoutWorkspace = ref.replace(/^w[0-9a-f]{32}_/, '')
	return withoutWorkspace.replace(/^integration-/, '').replace(/^github-/, 'GitHub · ')
}

const summarise = (grant: ToolGrant, tools: ToolGrantTool[] | undefined): string => {
	if (grant.mode === 'all') return 'All tools'
	if (grant.mode === 'read') {
		const n = (tools ?? []).filter((t) => t.readOnly === true).length
		return n ? `Read only · ${n} tools` : 'Read only'
	}
	const total = tools?.length
	return total ? `${grant.tools.length} of ${total}` : `${grant.tools.length} tools`
}

export function AgentAccessSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data, isLoading } = useToolGrants(workspaceId, agent.id)
	const revoke = useRevokeToolGrant(workspaceId)
	const [editing, setEditing] = useState<ToolGrant | null>(null)

	const granted = useMemo(
		() => (data?.grants ?? []).filter((g) => g.actorId === agent.id),
		[data?.grants, agent.id],
	)

	return (
		<section aria-labelledby="agent-access-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-access-heading"
				title="Integration access"
				note={
					<span
						className="shrink-0 tabular-nums text-[11px] text-muted-foreground"
						aria-label={`${granted.length} granted`}
					>
						· {granted.length}
					</span>
				}
			/>
			<div className="rounded-xl border border-border bg-card px-4 py-4">
				{isLoading ? null : granted.length === 0 ? (
					<EmptyState
						icon={<ShieldCheck className="size-5" />}
						title="No integrations granted"
						description="This agent cannot reach any workspace integration, and holds none of their credentials."
					/>
				) : (
					<ul className="space-y-2">
						{granted.map((grant) => (
							<li
								key={grant.id}
								className="flex items-center justify-between gap-3 rounded-md border border-border p-3"
							>
								<div className="min-w-0">
									<p className="truncate font-medium text-sm">{displayRef(grant.integrationRef)}</p>
									<p className="truncate text-text-secondary text-xs">
										{summarise(grant, data?.tools[grant.integrationRef])}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-2">
									<Button size="sm" variant="outline" onClick={() => setEditing(grant)}>
										Change
									</Button>
									<Button
										size="sm"
										variant="ghost"
										disabled={revoke.isPending}
										onClick={() => revoke.mutate(grant.id)}
									>
										Remove
									</Button>
								</div>
							</li>
						))}
					</ul>
				)}
			</div>

			{editing ? (
				<AccessDialog
					grant={editing}
					tools={data?.tools[editing.integrationRef] ?? []}
					agentId={agent.id}
					onClose={() => setEditing(null)}
				/>
			) : null}
		</section>
	)
}

function AccessDialog({
	grant,
	tools,
	agentId,
	onClose,
}: {
	grant: ToolGrant
	tools: ToolGrantTool[]
	agentId: string
	onClose: () => void
}) {
	const { workspaceId } = useWorkspace()
	const upsert = useUpsertToolGrant(workspaceId)
	const [mode, setMode] = useState<Mode>(grant.mode)
	const [chosen, setChosen] = useState<string[]>(grant.tools)
	const [query, setQuery] = useState('')

	// Three groups, because "unclassified" is a real answer rather than a gap to
	// paper over: the server did not say whether these write, so they are never
	// swept into a read-only grant.
	const groups = useMemo(() => {
		const match = (t: ToolGrantTool) => t.name.toLowerCase().includes(query.trim().toLowerCase())
		const visible = tools.filter(match)
		return {
			read: visible.filter((t) => t.readOnly === true),
			write: visible.filter((t) => t.readOnly === false),
			unknown: visible.filter((t) => t.readOnly === null),
		}
	}, [tools, query])

	const toggle = (name: string) =>
		setChosen((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name]))

	const save = () =>
		upsert.mutate(
			{
				actorId: agentId,
				integrationRef: grant.integrationRef,
				mode,
				tools: mode === 'custom' ? chosen : undefined,
			},
			{ onSuccess: onClose },
		)

	return (
		<Dialog open onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="flex max-h-[85dvh] flex-col">
				<DialogHeader>
					<DialogTitle>{displayRef(grant.integrationRef)}</DialogTitle>
					<DialogDescription>
						What this agent may do with it. Its credential is only sent to agents that have the
						integration at all.
					</DialogDescription>
				</DialogHeader>

				<RadioGroup
					value={mode}
					onValueChange={(next) => setMode(next as Mode)}
					aria-label="Access level"
					className="space-y-2"
				>
					{(
						[
							['all', 'All tools', 'Everything this integration offers, now and later.'],
							['read', 'Read only', 'Only tools the provider marks as read-only.'],
							['custom', 'Choose tools', 'Pick exactly which tools it can call.'],
						] as const
					).map(([value, label, hint]) => (
						<label
							key={value}
							htmlFor={`access-${value}`}
							className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3"
						>
							<RadioGroupItem id={`access-${value}`} value={value} className="mt-1" />
							<span className="min-w-0">
								<span className="block font-medium text-sm">{label}</span>
								<span className="block text-text-secondary text-xs">{hint}</span>
							</span>
						</label>
					))}
				</RadioGroup>

				{mode === 'read' && tools.every((t) => t.readOnly !== true) ? (
					// Better to say so than to save a grant that resolves to nothing.
					<p className="text-text-secondary text-xs">
						None of this integration's tools are marked read-only, so this would grant nothing.
					</p>
				) : null}

				{mode === 'custom' ? (
					<>
						<div className="space-y-1.5">
							<Label htmlFor="tool-search">Search tools</Label>
							<Input
								id="tool-search"
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="issue, search…"
								autoComplete="off"
							/>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto">
							{tools.length === 0 ? (
								<p className="py-3 text-text-secondary text-xs">
									We haven't listed this integration's tools yet — connect it, then reopen this.
								</p>
							) : (
								<>
									<ToolGroup title="Read" tools={groups.read} chosen={chosen} onToggle={toggle} />
									<ToolGroup title="Write" tools={groups.write} chosen={chosen} onToggle={toggle} />
									<ToolGroup
										title="Unclassified"
										hint="The provider didn't say whether these write."
										tools={groups.unknown}
										chosen={chosen}
										onToggle={toggle}
									/>
								</>
							)}
						</div>
					</>
				) : null}

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={save}
						disabled={upsert.isPending || (mode === 'custom' && chosen.length === 0)}
					>
						{upsert.isPending ? 'Saving…' : 'Save'}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function ToolGroup({
	title,
	hint,
	tools,
	chosen,
	onToggle,
}: {
	title: string
	hint?: string
	tools: ToolGrantTool[]
	chosen: string[]
	onToggle: (name: string) => void
}) {
	if (tools.length === 0) return null

	return (
		<div className="py-2">
			<p className="eyebrow">{title}</p>
			{hint ? <p className="pb-1 text-text-secondary text-xs">{hint}</p> : null}
			<ul>
				{tools.map((tool) => (
					<li key={tool.name}>
						<label className="flex cursor-pointer items-center gap-2 py-1">
							<Checkbox
								checked={chosen.includes(tool.name)}
								onCheckedChange={() => onToggle(tool.name)}
							/>
							<span className="truncate font-mono text-xs">{tool.name}</span>
						</label>
					</li>
				))}
			</ul>
		</div>
	)
}
