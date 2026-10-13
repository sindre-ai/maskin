import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Spinner } from '@/components/ui/spinner'
import { CREDENTIAL_NAME_MAX_LENGTH } from '@maskin/shared'
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
	/**
	 * Set when nothing was detected (the ! prefix): Service becomes a required text
	 * input instead of a read-only row, and the vault button waits for it.
	 */
	onServiceChange?: (service: string) => void
	serviceError?: string | null
	nameError?: string | null
	/** The env var the key will be read from, when the name gives a usable one. */
	envVar?: string | null
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
	onServiceChange,
	serviceError = null,
	nameError = null,
	envVar = null,
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
	const serviceId = useId()
	const nameNoteId = useId()
	const serviceNoteId = useId()
	const nameRef = useRef<HTMLInputElement>(null)
	// The step replaces the button that was focused, so focus moves into the card. It
	// comes back whenever the controls free up again: disabling the focused input while
	// a vault is in flight drops focus to the page, and without this a failed vault
	// leaves Esc (handled on the card) with nothing to listen to.
	useEffect(() => {
		if (!busy) nameRef.current?.focus()
	}, [busy])
	const count = selectedIds.size
	const serviceMissing = onServiceChange !== undefined && service.trim().length === 0
	const canVault =
		credentialName.trim().length > 0 && !serviceMissing && !nameError && !serviceError && !busy

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
						maxLength={CREDENTIAL_NAME_MAX_LENGTH}
						disabled={busy}
						aria-invalid={nameError ? true : undefined}
						aria-describedby={nameError || envVar ? nameNoteId : undefined}
						onChange={(e) => onCredentialNameChange(e.target.value)}
					/>
					{nameError ? (
						<p id={nameNoteId} className="text-xs text-error">
							{nameError}
						</p>
					) : envVar ? (
						<p id={nameNoteId} className="break-words text-xs text-muted-foreground">
							Env var <code className="font-mono">{envVar}</code>
						</p>
					) : null}
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor={onServiceChange ? serviceId : undefined}>Service</Label>
					{onServiceChange ? (
						<>
							<Input
								id={serviceId}
								value={service}
								placeholder="e.g. Linear"
								maxLength={CREDENTIAL_NAME_MAX_LENGTH}
								disabled={busy}
								aria-invalid={serviceError ? true : undefined}
								aria-describedby={serviceError || serviceMissing ? serviceNoteId : undefined}
								onChange={(e) => onServiceChange(e.target.value)}
							/>
							{serviceError ? (
								<p id={serviceNoteId} className="text-xs text-error">
									{serviceError}
								</p>
							) : serviceMissing ? (
								<p id={serviceNoteId} className="text-xs text-muted-foreground">
									Add the service name to continue.
								</p>
							) : null}
						</>
					) : (
						<div className="flex h-10 items-center rounded-md border border-input bg-muted px-3 text-sm text-muted-foreground">
							{service}
						</div>
					)}
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
				<Button type="button" variant="outline" disabled={!canVault} onClick={onSaveUnassigned}>
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
