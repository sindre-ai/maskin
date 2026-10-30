import {
	SIGNATURE_SCHEMES,
	type WebhookFormErrors,
	type WebhookFormState,
	formFromRecipe,
} from '@/components/extensions/webhook-form'
import { FormError } from '@/components/shared/form-error'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { MaskedSecret } from '@/components/ui/masked-secret'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import type { ExtensionResponse, ExtensionSignatureScheme, VendorRecipe } from '@/lib/api'
import { RefreshCw, Wand2 } from 'lucide-react'

const CUSTOM_RECIPE = 'custom'

/** Webhook half of the detail page: saved summary, or the editable form. */
export function WebhookSection({
	ext,
	editing,
	form,
	errors,
	recipes,
	onChange,
	onEdit,
	onGenerateSecret,
	generatingSecret,
	onRegenerateToken,
}: {
	ext: ExtensionResponse
	editing: boolean
	form: WebhookFormState
	errors: WebhookFormErrors
	recipes: VendorRecipe[]
	onChange: (next: WebhookFormState) => void
	onEdit: () => void
	onGenerateSecret: () => void
	generatingSecret: boolean
	onRegenerateToken: () => void
}) {
	const saved = !!ext.webhookConfig
	const set = <K extends keyof WebhookFormState>(key: K, value: WebhookFormState[K]) =>
		onChange({ ...form, [key]: value })

	if (saved && !editing) {
		const cfg = ext.webhookConfig
		const scheme = SIGNATURE_SCHEMES.find((s) => s.value === cfg?.signatureScheme)
		return (
			<section
				className="rounded-xl border border-border bg-card p-4"
				aria-labelledby="webhook-heading"
			>
				<div className="flex items-start justify-between gap-3">
					<div>
						<h2 id="webhook-heading" className="text-[13px] font-bold">
							Incoming webhook
						</h2>
						<p className="text-xs text-muted-foreground">
							The vendor pushes events into this workspace.
						</p>
					</div>
					<Button variant="secondary" size="sm" onClick={onEdit}>
						Edit
					</Button>
				</div>

				<div className="mt-4 grid gap-4">
					<div className="grid gap-1.5">
						<Label>Webhook URL</Label>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
							<code className="block min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs">
								{ext.webhookUrl}
							</code>
							{ext.webhookUrl && (
								<CopyButton text={ext.webhookUrl} label ariaLabel="Copy webhook URL" />
							)}
						</div>
						<div>
							<Button
								variant="ghost"
								size="sm"
								onClick={onRegenerateToken}
								className="-ml-3 text-muted-foreground"
							>
								<RefreshCw size={14} />
								Regenerate token
							</Button>
						</div>
					</div>

					<div className="grid gap-1.5">
						<Label>Signing secret</Label>
						<MaskedSecret aria-label="Signing secret (hidden)" />
					</div>

					<dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
						<div>
							<dt className="text-muted-foreground">Signature scheme</dt>
							<dd className="font-medium">{scheme?.label}</dd>
						</div>
						<div>
							<dt className="text-muted-foreground">Signature header</dt>
							<dd className="font-mono">{cfg?.signatureHeader}</dd>
						</div>
					</dl>
				</div>
			</section>
		)
	}

	const applyRecipe = (slug: string) => {
		if (slug === CUSTOM_RECIPE) return
		const recipe = recipes.find((r) => r.slug === slug)
		if (recipe) onChange(formFromRecipe(recipe, form))
	}

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="webhook-heading"
		>
			<h2 id="webhook-heading" className="text-[13px] font-bold">
				Incoming webhook
			</h2>
			<p className="text-xs text-muted-foreground">
				The vendor pushes events into this workspace. The URL is generated when you save.
			</p>

			<div className="mt-4 grid gap-4">
				{!saved && recipes.length > 0 && (
					<div className="grid gap-1.5">
						<Label htmlFor="recipe">Start from a recipe</Label>
						<Select defaultValue={CUSTOM_RECIPE} onValueChange={applyRecipe}>
							<SelectTrigger id="recipe" className="sm:max-w-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value={CUSTOM_RECIPE}>Custom</SelectItem>
								{recipes.map((r) => (
									<SelectItem key={r.slug} value={r.slug}>
										{r.displayName}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
				)}

				<div className="grid gap-1.5">
					<Label htmlFor="signature-scheme">Signature scheme</Label>
					<Select
						value={form.scheme}
						onValueChange={(v) => set('scheme', v as ExtensionSignatureScheme)}
					>
						<SelectTrigger id="signature-scheme" className="sm:max-w-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{SIGNATURE_SCHEMES.map((s) => (
								<SelectItem key={s.value} value={s.value}>
									{s.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<p className="text-xs text-muted-foreground">
						Which family of signature the vendor signs requests with. HMAC-SHA256 raw body is the
						most common (Fireflies, GitHub). Timestamp + body is the Stripe and Slack style.
					</p>
				</div>

				<div className="grid items-start gap-4 sm:grid-cols-2">
					<div className="grid gap-1.5">
						<Label htmlFor="signature-header">Signature header</Label>
						<Input
							id="signature-header"
							value={form.signatureHeader}
							onChange={(e) => set('signatureHeader', e.target.value)}
							placeholder="X-Hub-Signature"
							aria-invalid={!!errors.signatureHeader}
						/>
						<FormError error={errors.signatureHeader} />
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="signature-prefix">Signature prefix</Label>
						<Input
							id="signature-prefix"
							value={form.signaturePrefix}
							onChange={(e) => set('signaturePrefix', e.target.value)}
							placeholder="sha256="
						/>
						<p className="text-xs text-muted-foreground">Optional. Text before the signature.</p>
					</div>
				</div>

				{form.scheme === 'timestamp' && (
					<div className="grid items-start gap-4 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor="timestamp-header">Timestamp header</Label>
							<Input
								id="timestamp-header"
								value={form.timestampHeader}
								onChange={(e) => set('timestampHeader', e.target.value)}
								placeholder="X-Slack-Request-Timestamp"
								aria-invalid={!!errors.timestampHeader}
							/>
							<FormError error={errors.timestampHeader} />
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="timestamp-template">Signed text</Label>
							<Input
								id="timestamp-template"
								value={form.timestampBodyTemplate}
								onChange={(e) => set('timestampBodyTemplate', e.target.value)}
								placeholder="v0:{timestamp}:{body}"
								aria-invalid={!!errors.timestampBodyTemplate}
							/>
							<FormError error={errors.timestampBodyTemplate} />
						</div>
					</div>
				)}

				<div className="grid gap-1.5">
					<Label htmlFor="signing-secret">Signing secret</Label>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							id="signing-secret"
							type="password"
							autoComplete="off"
							value={form.signingSecret}
							onChange={(e) => set('signingSecret', e.target.value)}
							placeholder={
								saved ? 'Leave blank to keep the current secret' : 'Paste or generate a secret'
							}
							aria-invalid={!!errors.signingSecret}
							className="sm:flex-1"
						/>
						<Button
							type="button"
							variant="secondary"
							onClick={onGenerateSecret}
							disabled={generatingSecret}
						>
							<Wand2 size={14} />
							Generate one
						</Button>
					</div>
					<p className="text-xs text-muted-foreground">
						Choose your own with Generate, then paste it into the vendor. If the vendor issues its
						own secret, paste that instead. Stored encrypted.
					</p>
					<FormError error={errors.signingSecret} />
				</div>
			</div>
		</section>
	)
}
