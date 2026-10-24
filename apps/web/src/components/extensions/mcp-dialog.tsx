import {
	MAX_EXTENSION_TOOLS,
	type McpFormState,
	type McpToolRow,
	buildMcpConfig,
	capMessage,
	emptyMcpForm,
	formFromMcpConfig,
	rowsFromDeclared,
	rowsFromProbe,
	rowsFromSaved,
	selectedTools,
	validateMcpForm,
} from '@/components/extensions/mcp-form'
import { FormError } from '@/components/shared/form-error'
import { Badge } from '@/components/ui/badge'
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
import { MaskedSecret } from '@/components/ui/masked-secret'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useProbeMcp, useUpdateExtension } from '@/hooks/use-extensions'
import type { ExtensionMcpConfig, ExtensionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'

type Step =
	| { name: 'form' }
	| { name: 'verifying' }
	| { name: 'error'; message: string }
	| { name: 'declare'; text: string }
	| { name: 'tools'; rows: McpToolRow[]; verified: boolean }

const VERIFY_STEPS = ['Reaching server', 'Authenticating', 'Listing tools']

/**
 * Add or edit an extension's MCP (design spec A, MCP config modal). Verify and
 * save asks the server for its tools first; nothing is stored until the owner
 * has seen them and pressed Save. A failed probe keeps the modal open with the
 * error band, and the owner can declare the tools by hand instead.
 */
export function McpDialog({
	ext,
	workspaceId,
	initialUrl,
	open,
	onOpenChange,
}: {
	ext: ExtensionResponse
	workspaceId: string
	/** Pre-fill from a vendor recipe when nothing is saved yet. */
	initialUrl?: string
	open: boolean
	onOpenChange: (open: boolean) => void
}) {
	const saved = ext.mcpConfig as ExtensionMcpConfig | null
	const editing = !!saved
	const probe = useProbeMcp(workspaceId)
	const update = useUpdateExtension(workspaceId, ext.id)
	const [form, setForm] = useState<McpFormState>(() =>
		saved ? formFromMcpConfig(ext) : emptyMcpForm(initialUrl),
	)
	const [attempted, setAttempted] = useState(false)
	const [step, setStep] = useState<Step>(
		saved ? { name: 'tools', rows: rowsFromSaved(saved.tools), verified: true } : { name: 'form' },
	)
	const [saveError, setSaveError] = useState<string | null>(null)

	const errors = attempted ? validateMcpForm(form, { editing }) : {}
	const set = <K extends keyof McpFormState>(key: K, value: McpFormState[K]) =>
		setForm((f) => ({ ...f, [key]: value }))
	const urlChanged =
		editing && form.serverUrl.trim() !== formFromMcpConfig(ext).serverUrl && !form.replaceKey

	const handleVerify = async () => {
		const found = validateMcpForm(form, { editing })
		if (Object.keys(found).length > 0 || urlChanged) {
			setAttempted(true)
			return
		}
		setStep({ name: 'verifying' })
		try {
			const result = await probe.mutateAsync({
				server_url: form.serverUrl.trim(),
				...(form.auth === 'api-key' && form.apiKey ? { api_key: form.apiKey } : {}),
			})
			setStep(
				result.ok
					? { name: 'tools', rows: rowsFromProbe(result.tools), verified: true }
					: { name: 'error', message: result.message },
			)
		} catch {
			setStep({ name: 'error', message: "Couldn't reach Maskin to verify the server." })
		}
	}

	const handleSave = async (rows: McpToolRow[]) => {
		setSaveError(null)
		const keyToSend = form.auth === 'api-key' && form.apiKey ? form.apiKey : undefined
		try {
			await update.mutateAsync({
				mcp_config: buildMcpConfig({
					slug: ext.slug,
					serverUrl: form.serverUrl,
					auth: form.auth,
					tools: selectedTools(rows),
				}),
				status: 'active',
				...(keyToSend ? { mcp_api_key: keyToSend } : {}),
			})
			onOpenChange(false)
		} catch (err) {
			setSaveError(err instanceof Error ? err.message : 'Could not save the MCP')
		}
	}

	const busy = step.name === 'verifying' || update.isPending
	const backToForm = () => {
		setAttempted(false)
		setStep({ name: 'form' })
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-h-[100dvh] overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:h-[100dvh] max-sm:w-full max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-none">
				<DialogHeader>
					<DialogTitle>{editing ? `Edit ${ext.name} MCP` : 'Add an MCP'}</DialogTitle>
					<DialogDescription>
						The extension's tools become callable by agents once verified.
					</DialogDescription>
				</DialogHeader>

				{(step.name === 'form' || step.name === 'verifying' || step.name === 'error') && (
					<McpFields
						form={form}
						errors={errors}
						editing={editing}
						hasStoredKey={ext.hasMcpKey}
						disabled={busy}
						set={set}
					/>
				)}

				{step.name === 'verifying' && (
					<ol className="grid gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-xs">
						{VERIFY_STEPS.map((label) => (
							<li key={label} className="flex items-center gap-2 text-muted-foreground">
								<Spinner />
								{label}
							</li>
						))}
					</ol>
				)}

				{step.name === 'error' && (
					<div
						role="alert"
						className="grid gap-1 rounded-lg border border-error/40 bg-error/10 px-3 py-2 text-xs"
					>
						<p className="font-semibold text-error">Couldn't verify {ext.name} MCP</p>
						<p>{step.message} Nothing was saved.</p>
						<p className="text-muted-foreground">
							Check the address and the key, then retry. Or declare the tools by hand.
						</p>
					</div>
				)}

				{step.name === 'declare' && (
					<div className="grid gap-1.5">
						<Label htmlFor="mcp-declared">Tool names</Label>
						<Textarea
							id="mcp-declared"
							rows={5}
							className="font-mono text-xs"
							placeholder={'get_transcript\nlist_transcripts'}
							value={step.text}
							onChange={(e) => setStep({ name: 'declare', text: e.target.value })}
						/>
						<p className="text-xs text-muted-foreground">
							One per line. Names starting get_, list_, read_, search_ or find_ default to read.
						</p>
					</div>
				)}

				{step.name === 'tools' && (
					<ToolPicker
						rows={step.rows}
						verified={step.verified}
						onChange={(rows) => setStep({ ...step, rows })}
					/>
				)}

				{saveError && <FormError error={saveError} />}

				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="ghost" onClick={() => onOpenChange(false)} disabled={update.isPending}>
						Cancel
					</Button>
					{step.name === 'form' && (
						<Button onClick={handleVerify} disabled={!form.serverUrl.trim()}>
							Verify & save
						</Button>
					)}
					{step.name === 'verifying' && (
						<Button disabled>
							<Spinner />
							Verifying
						</Button>
					)}
					{step.name === 'error' && (
						<>
							<Button variant="ghost" onClick={() => setStep({ name: 'declare', text: '' })}>
								Declare tools by hand
							</Button>
							<Button variant="secondary" onClick={backToForm}>
								Edit
							</Button>
							<Button onClick={handleVerify}>Retry</Button>
						</>
					)}
					{step.name === 'declare' && (
						<>
							<Button variant="secondary" onClick={backToForm}>
								Back
							</Button>
							<Button
								disabled={rowsFromDeclared(step.text).rows.length === 0}
								onClick={() =>
									setStep({
										name: 'tools',
										rows: rowsFromDeclared(step.text).rows,
										verified: false,
									})
								}
							>
								Continue
							</Button>
						</>
					)}
					{step.name === 'tools' && (
						<>
							{editing && (
								<Button variant="secondary" onClick={backToForm}>
									Change server or key
								</Button>
							)}
							<Button
								disabled={
									update.isPending ||
									selectedTools(step.rows).length === 0 ||
									selectedTools(step.rows).length > MAX_EXTENSION_TOOLS
								}
								onClick={() => handleSave(step.rows)}
							>
								Save
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}

function McpFields({
	form,
	errors,
	editing,
	hasStoredKey,
	disabled,
	set,
}: {
	form: McpFormState
	errors: ReturnType<typeof validateMcpForm>
	editing: boolean
	hasStoredKey: boolean
	disabled: boolean
	set: <K extends keyof McpFormState>(key: K, value: McpFormState[K]) => void
}) {
	return (
		<div className="grid gap-4">
			<div className="grid gap-1.5">
				<Label htmlFor="mcp-url">Server URL</Label>
				<Input
					id="mcp-url"
					type="url"
					placeholder="https://api.fireflies.ai/mcp"
					value={form.serverUrl}
					disabled={disabled}
					aria-invalid={!!errors.serverUrl}
					onChange={(e) => set('serverUrl', e.target.value)}
				/>
				<FormError error={errors.serverUrl} />
				<p className="text-xs text-muted-foreground">
					Any hosted MCP server. HTTPS required. Servers that only speak HTTP transport are not
					supported yet.
				</p>
			</div>

			<fieldset className="grid gap-1.5" disabled={disabled}>
				<legend className="text-sm font-medium leading-none text-muted-foreground">
					Auth mode
				</legend>
				<RadioGroup
					value={form.auth}
					onValueChange={(v) => set('auth', v === 'none' ? 'none' : 'api-key')}
				>
					<AuthOption value="api-key" label="API key" hint="Sent as Authorization: Bearer" />
					<AuthOption value="none" label="None" hint="The server needs no key" />
					<AuthOption
						value="oauth"
						label="OAuth 2.1"
						hint="Not available yet"
						disabled
						badge="soon"
					/>
				</RadioGroup>
			</fieldset>

			{form.auth === 'api-key' && (
				<div className="grid gap-1.5">
					<Label htmlFor="mcp-key">API key</Label>
					{editing && hasStoredKey && !form.replaceKey ? (
						<div className="flex items-center gap-2">
							<MaskedSecret aria-label="API key (hidden)" className="min-w-0 flex-1" />
							<Button variant="secondary" size="sm" onClick={() => set('replaceKey', true)}>
								Replace key
							</Button>
						</div>
					) : (
						<Input
							id="mcp-key"
							type="password"
							autoComplete="off"
							placeholder="Paste the vendor's API key"
							value={form.apiKey}
							disabled={disabled}
							aria-invalid={!!errors.apiKey}
							onChange={(e) => set('apiKey', e.target.value)}
						/>
					)}
					<FormError error={errors.apiKey} />
					<p className="text-xs text-muted-foreground">
						Encrypted at rest. Only decrypted when a tool call is made.
					</p>
				</div>
			)}
		</div>
	)
}

function AuthOption({
	value,
	label,
	hint,
	disabled,
	badge,
}: { value: string; label: string; hint: string; disabled?: boolean; badge?: string }) {
	const id = `mcp-auth-${value}`
	return (
		<div className="flex items-center gap-2">
			<RadioGroupItem value={value} id={id} disabled={disabled} />
			<Label
				htmlFor={id}
				className={cn('flex flex-1 items-baseline gap-2', disabled && 'opacity-60')}
			>
				<span>{label}</span>
				<span className="text-xs font-normal text-muted-foreground">{hint}</span>
			</Label>
			{badge && <Badge variant="outline">{badge}</Badge>}
		</div>
	)
}

function ToolPicker({
	rows,
	verified,
	onChange,
}: { rows: McpToolRow[]; verified: boolean; onChange: (rows: McpToolRow[]) => void }) {
	const count = rows.filter((r) => r.selected).length
	const over = capMessage(count)
	const patch = (name: string, change: Partial<McpToolRow>) =>
		onChange(rows.map((r) => (r.name === name ? { ...r, ...change } : r)))

	return (
		<div className="grid gap-2">
			<p className="text-xs text-muted-foreground">
				{verified
					? `${rows.length} ${rows.length === 1 ? 'tool' : 'tools'} found. Tick the ones agents may be given, and mark each as read or write.`
					: 'Declared by hand, not verified against the server. Mark each as read or write.'}
			</p>
			<ul className="grid gap-1">
				{rows.map((r) => {
					const id = `mcp-tool-${r.name}`
					return (
						<li key={r.name} className="flex items-center gap-3 rounded-lg p-1.5">
							<Checkbox
								id={id}
								checked={r.selected}
								onCheckedChange={(v) => patch(r.name, { selected: v === true })}
							/>
							<Label htmlFor={id} className="min-w-0 flex-1 truncate font-mono text-xs">
								{r.name}
							</Label>
							<div className="flex shrink-0 items-center gap-1.5">
								<Checkbox
									id={`${id}-write`}
									aria-label={`${r.name} is a write tool`}
									checked={r.kind === 'write'}
									onCheckedChange={(v) => patch(r.name, { kind: v === true ? 'write' : 'read' })}
								/>
								<Label htmlFor={`${id}-write`} className="text-[11px]">
									write
								</Label>
							</div>
						</li>
					)
				})}
			</ul>
			<p
				className={cn('text-xs', over ? 'text-error' : 'text-muted-foreground')}
				aria-live="polite"
			>
				Selected: {count}/{MAX_EXTENSION_TOOLS}
			</p>
			{over && (
				<p role="alert" className="flex items-start gap-1.5 text-xs text-error">
					<AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
					{over}
				</p>
			)}
			<p className="rounded-lg border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
				Next: agent access. By default, no agents can call these tools. Grant access in the Agent
				access section below.
			</p>
		</div>
	)
}
