import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
} from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { useIsMobile } from '@/hooks/use-mobile'
import { ApiError, type KeychainScopeGrant } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useId, useState } from 'react'

export interface ScopeAgent {
	id: string
	name: string
}

/** A 403 carries the server's reason; anything else is the same plain line. */
export function scopeSaveErrorMessage(error: unknown): string {
	if (error instanceof ApiError && error.status === 403) return error.message
	return "Couldn't save access. Nothing changed."
}

/** How many agents a set of grants reaches. Humans and loops are not agents. */
export function countAgents(grants: KeychainScopeGrant[], agents: ScopeAgent[]): number {
	if (grants.some((g) => g.kind === 'workspace')) return agents.length
	const ids = new Set(agents.map((a) => a.id))
	return grants.filter((g) => g.kind === 'actor' && ids.has(g.actorId)).length
}

export function agentCountLine(count: number): string {
	return `Available to ${count} ${count === 1 ? 'agent' : 'agents'}`
}

export const NO_AGENT_LINE = 'No agent can use this key yet.'

interface ScopeEditorSheetProps {
	open: boolean
	onOpenChange: (open: boolean) => void
	credentialName: string
	/** Every agent in the workspace. */
	agents: ScopeAgent[]
	/** What the key is granted to now. */
	grants: KeychainScopeGrant[]
	saving: boolean
	/** Shown inside the sheet, in red. */
	error: string | null
	onSave: (grants: KeychainScopeGrant[]) => void
}

/**
 * Edit who may use a saved key. Right sheet from tablet up, bottom sheet on a phone. The
 * form mounts with the sheet content, so it starts from the saved grants every time it opens.
 */
export function ScopeEditorSheet({ open, onOpenChange, ...form }: ScopeEditorSheetProps) {
	const isMobile = useIsMobile()
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={isMobile ? 'bottom' : 'right'}
				className={cn(
					'flex flex-col',
					isMobile ? 'max-h-[85dvh] w-full max-w-none rounded-t-lg' : 'w-full sm:max-w-md',
				)}
			>
				<ScopeForm {...form} />
			</SheetContent>
		</Sheet>
	)
}

function ScopeForm({
	credentialName,
	agents,
	grants,
	saving,
	error,
	onSave,
}: Omit<ScopeEditorSheetProps, 'open' | 'onOpenChange'>) {
	const [everyone, setEveryone] = useState(grants.some((g) => g.kind === 'workspace'))
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		() =>
			new Set(
				grants.flatMap((g) =>
					g.kind === 'actor' && agents.some((a) => a.id === g.actorId) ? [g.actorId] : [],
				),
			),
	)

	const next: KeychainScopeGrant[] = everyone
		? [{ kind: 'workspace' }]
		: agents.filter((a) => selected.has(a.id)).map((a) => ({ kind: 'actor', actorId: a.id }))
	const count = countAgents(next, agents)

	const toggle = (agentId: string) =>
		setSelected((prev) => {
			const copy = new Set(prev)
			if (copy.has(agentId)) copy.delete(agentId)
			else copy.add(agentId)
			return copy
		})

	return (
		<>
			<SheetHeader>
				<SheetTitle>Edit access</SheetTitle>
				<SheetDescription>Choose which agents can use {credentialName}.</SheetDescription>
			</SheetHeader>

			<div className="mt-4 flex min-h-0 flex-1 flex-col gap-3">
				{/* The list scrolls on a short screen; the count, the note and any error stay put. */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					<fieldset className="flex flex-col gap-1.5">
						<legend className="sr-only">Agents that can use this key</legend>
						<ScopeRow
							label="All agents in this workspace"
							checked={everyone}
							disabled={saving}
							onToggle={() => setEveryone((v) => !v)}
						/>
						{agents.map((agent) => (
							<ScopeRow
								key={agent.id}
								label={agent.name}
								checked={selected.has(agent.id)}
								disabled={saving || everyone}
								onToggle={() => toggle(agent.id)}
							/>
						))}
					</fieldset>
				</div>

				<output className="block text-sm font-medium" aria-live="polite">
					{count === 0 ? NO_AGENT_LINE : agentCountLine(count)}
				</output>
				<p className="text-xs text-muted-foreground">
					Applies to new sessions. A session already running keeps the key until it ends.
				</p>

				{error ? (
					<p
						role="alert"
						className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
					>
						{error}
					</p>
				) : null}
			</div>

			<SheetFooter className="mt-4 gap-2">
				<Button type="button" disabled={saving} onClick={() => onSave(next)}>
					{saving ? <Spinner /> : null}
					Save access
				</Button>
			</SheetFooter>
		</>
	)
}

function ScopeRow({
	label,
	checked,
	disabled,
	onToggle,
}: {
	label: string
	checked: boolean
	disabled: boolean
	onToggle: () => void
}) {
	const id = useId()
	return (
		<div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
			<Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
			<Label htmlFor={id} className="min-w-0 flex-1 truncate text-sm font-normal">
				{label}
			</Label>
		</div>
	)
}
