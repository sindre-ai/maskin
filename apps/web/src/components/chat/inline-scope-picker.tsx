import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { ChevronDown } from 'lucide-react'
import { useEffect, useId, useRef } from 'react'

export interface ScopeAgent {
	id: string
	name: string
}

interface InlineScopePickerProps {
	credentialName: string
	onCredentialNameChange: (name: string) => void
	service: string
	/** The agent running this session. Pre-selected by the parent. */
	sessionAgent: ScopeAgent
	/** Every other agent in the workspace, behind the expander. */
	otherAgents: ScopeAgent[]
	selectedIds: ReadonlySet<string>
	onToggle: (agentId: string) => void
	busy: boolean
	error: string | null
	onSaveUnassigned: () => void
	onVault: () => void
}

/**
 * The scope step of the in-chat vault flow, sized to sit inside the chat card. The
 * Keychain page's right-hand sheet would take the user out of the conversation, so
 * this stays inline. There is no sessions-per-week estimate on purpose: nothing
 * sources that number yet, and an invented figure beside a security decision is
 * worse than none.
 */
export function InlineScopePicker({
	credentialName,
	onCredentialNameChange,
	service,
	sessionAgent,
	otherAgents,
	selectedIds,
	onToggle,
	busy,
	error,
	onSaveUnassigned,
	onVault,
}: InlineScopePickerProps) {
	const nameId = useId()
	const nameRef = useRef<HTMLInputElement>(null)
	// The step replaces the button that was focused, so focus moves into the card.
	useEffect(() => {
		nameRef.current?.focus()
	}, [])
	const count = selectedIds.size
	const canVault = credentialName.trim().length > 0 && !busy

	return (
		<div className="flex flex-col gap-3">
			<h3 className="text-sm font-semibold">
				Assign scope for {credentialName || 'this credential'}
			</h3>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={nameId}>Credential name</Label>
					<Input
						ref={nameRef}
						id={nameId}
						value={credentialName}
						maxLength={80}
						disabled={busy}
						onChange={(e) => onCredentialNameChange(e.target.value)}
						onKeyDown={(e) => {
							// Enter submits the scope only from here, never from the composer.
							if (e.key === 'Enter' && canVault) {
								e.preventDefault()
								onVault()
							}
						}}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>Service</Label>
					<div className="flex h-10 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
						{service}
					</div>
				</div>
			</div>

			<output className="block text-xs text-muted-foreground" aria-live="polite">
				{count === 0
					? 'Blast radius: 0 agents. Nothing is authorised yet.'
					: `Blast radius: ${count} ${count === 1 ? 'agent' : 'agents'}`}
			</output>
			<p className="text-xs text-muted-foreground">
				The agent you're chatting with ({sessionAgent.name}) is pre-selected — so this session can
				continue right after you save. Uncheck it to keep this credential unassigned.
			</p>

			<fieldset className="flex flex-col gap-1.5">
				<legend className="mb-1 text-xs font-medium text-muted-foreground">
					Suggested (this session's agent)
				</legend>
				<AgentRow
					agent={sessionAgent}
					eyebrow="this session's agent"
					checked={selectedIds.has(sessionAgent.id)}
					disabled={busy}
					onToggle={onToggle}
				/>
			</fieldset>

			{otherAgents.length > 0 ? (
				<Collapsible>
					<CollapsibleTrigger asChild>
						<Button type="button" variant="ghost" size="sm" className="gap-1.5">
							<ChevronDown aria-hidden />
							Pick from all workspace agents
						</Button>
					</CollapsibleTrigger>
					<CollapsibleContent className="mt-1 flex max-h-48 flex-col gap-1.5 overflow-y-auto">
						{otherAgents.map((agent) => (
							<AgentRow
								key={agent.id}
								agent={agent}
								checked={selectedIds.has(agent.id)}
								disabled={busy}
								onToggle={onToggle}
							/>
						))}
					</CollapsibleContent>
				</Collapsible>
			) : null}

			{error ? (
				<p
					role="alert"
					className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-xs text-error"
				>
					{error}
				</p>
			) : null}

			<div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
				<Button type="button" variant="outline" disabled={busy} onClick={onSaveUnassigned}>
					Save unassigned
				</Button>
				<Button type="button" disabled={!canVault} onClick={onVault}>
					{busy ? <Spinner /> : null}
					Vault + continue chat →
				</Button>
			</div>
			<p className="text-xs text-muted-foreground">
				<span aria-hidden>🔒 </span>Assign scope above to resume this session.
			</p>
		</div>
	)
}

function AgentRow({
	agent,
	eyebrow,
	checked,
	disabled,
	onToggle,
}: {
	agent: ScopeAgent
	eyebrow?: string
	checked: boolean
	disabled: boolean
	onToggle: (agentId: string) => void
}) {
	const id = useId()
	return (
		<div className="flex items-center gap-2 rounded-md border border-border px-3 py-2">
			<Checkbox
				id={id}
				checked={checked}
				disabled={disabled}
				onCheckedChange={() => onToggle(agent.id)}
			/>
			<Label htmlFor={id} className="flex min-w-0 flex-col gap-0.5 font-normal">
				<span className="truncate text-sm font-medium">{agent.name}</span>
				{eyebrow ? <span className="text-xs text-muted-foreground">{eyebrow}</span> : null}
			</Label>
		</div>
	)
}
