import { AgentAccessSection } from '@/components/extensions/agent-access-section'
import { extensionRowStatus } from '@/components/extensions/custom-extensions-section'
import { DeliveryHistory } from '@/components/extensions/delivery-history'
import { MappingSection } from '@/components/extensions/mapping-section'
import { McpSection } from '@/components/extensions/mcp-section'
import { SampleTester } from '@/components/extensions/sample-tester'
import { SetupProgressCard } from '@/components/extensions/setup-progress-card'
import {
	type WebhookFormErrors,
	type WebhookFormState,
	configFromForm,
	emptyWebhookForm,
	formFromConfig,
	hasErrors,
	validateWebhookForm,
} from '@/components/extensions/webhook-form'
import { WebhookRevealDialog } from '@/components/extensions/webhook-reveal-dialog'
import { WebhookSection } from '@/components/extensions/webhook-section'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useExtension,
	useGenerateExtensionSecret,
	useRegenerateExtensionToken,
	useUpdateExtension,
	useVendorRecipes,
} from '@/hooks/use-extensions'
import type { ExtensionResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ArrowLeft } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

type Reveal = { webhookUrl: string; secret?: string }

export function ExtensionDetail({ extId }: { extId: string }) {
	const { workspaceId } = useWorkspace()
	const { data: ext, isLoading, isError } = useExtension(workspaceId, extId)

	if (isLoading) return <ListSkeleton rows={4} />
	if (isError || !ext) {
		return <p className="text-sm text-error">This extension could not be loaded.</p>
	}
	return <ExtensionDetailBody ext={ext} workspaceId={workspaceId} />
}

function ExtensionDetailBody({
	ext,
	workspaceId,
}: { ext: ExtensionResponse; workspaceId: string }) {
	const canWrite = useCanWrite()
	const update = useUpdateExtension(workspaceId, ext.id)
	const regenerate = useRegenerateExtensionToken(workspaceId, ext.id)
	const generateSecret = useGenerateExtensionSecret(workspaceId)
	const { data: recipes = [] } = useVendorRecipes(workspaceId)

	const saved = !!ext.webhookConfig
	const [editing, setEditing] = useState(!saved)
	const [form, setForm] = useState<WebhookFormState>(() =>
		ext.webhookConfig ? formFromConfig(ext.webhookConfig) : emptyWebhookForm(),
	)
	const [attempted, setAttempted] = useState(false)
	const [reveal, setReveal] = useState<Reveal | null>(null)
	const [confirmRegenerate, setConfirmRegenerate] = useState(false)

	const errors: WebhookFormErrors = attempted
		? validateWebhookForm(form, { requireSecret: !ext.hasSigningSecret })
		: {}
	const status = extensionRowStatus(ext)
	// The config as filled in, for the dry run, once it would pass the same checks as Save.
	const draftConfig = hasErrors(validateWebhookForm(form, { requireSecret: false }))
		? null
		: configFromForm(form)

	const startEditing = () => {
		if (!canWrite) return
		if (ext.webhookConfig) setForm(formFromConfig(ext.webhookConfig))
		setAttempted(false)
		setEditing(true)
	}

	const cancelEditing = () => {
		if (ext.webhookConfig) setForm(formFromConfig(ext.webhookConfig))
		setAttempted(false)
		setEditing(false)
	}

	const handleGenerate = async () => {
		if (!canWrite) return
		try {
			const { secret } = await generateSecret.mutateAsync()
			setForm((f) => ({ ...f, signingSecret: secret }))
		} catch {
			toast.error('Could not generate a secret')
		}
	}

	const handleSave = async () => {
		if (!canWrite) return
		const found = validateWebhookForm(form, { requireSecret: !ext.hasSigningSecret })
		if (hasErrors(found)) {
			setAttempted(true)
			return
		}
		const secret = form.signingSecret || undefined
		try {
			const updated = await update.mutateAsync({
				webhook_config: configFromForm(form),
				status: 'active',
				...(secret ? { signing_secret: secret } : {}),
			})
			setEditing(false)
			setAttempted(false)
			setForm((f) => ({ ...f, signingSecret: '' }))
			if (secret && updated.webhookUrl) {
				setReveal({ webhookUrl: updated.webhookUrl, secret })
			} else {
				toast.success('Webhook saved')
			}
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not save the webhook')
		}
	}

	const handleRegenerate = async () => {
		if (!canWrite) return
		try {
			const updated = await regenerate.mutateAsync()
			setConfirmRegenerate(false)
			if (updated.webhookUrl) setReveal({ webhookUrl: updated.webhookUrl })
		} catch (err) {
			toast.error(err instanceof Error ? err.message : 'Could not regenerate the token')
		}
	}

	return (
		<div className="max-w-[960px] space-y-4">
			<div>
				<Link
					to="/$workspaceId/settings/extensions"
					params={{ workspaceId }}
					className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
				>
					<ArrowLeft size={12} aria-hidden />
					Extensions
				</Link>
				<div className="flex items-center gap-3">
					<h1 className="min-w-0 truncate text-lg font-bold">{ext.name}</h1>
					<Badge variant={status.variant}>{status.label}</Badge>
				</div>
			</div>

			<SetupProgressCard ext={ext} />

			<McpSection ext={ext} workspaceId={workspaceId} recipes={recipes} />

			<WebhookSection
				ext={ext}
				editing={editing}
				form={form}
				errors={errors}
				recipes={recipes}
				onChange={setForm}
				onEdit={startEditing}
				onGenerateSecret={handleGenerate}
				generatingSecret={generateSecret.isPending}
				onRegenerateToken={() => setConfirmRegenerate(true)}
			/>

			{editing && (
				<>
					<MappingSection form={form} errors={errors} onChange={setForm} />
					<SampleTester workspaceId={workspaceId} extensionId={ext.id} config={draftConfig} />
					<div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
						{saved && (
							<Button type="button" variant="ghost" onClick={cancelEditing}>
								Cancel
							</Button>
						)}
						<ViewerTooltip>
							<Button type="button" onClick={handleSave} disabled={update.isPending || !canWrite}>
								{saved ? 'Save changes' : 'Save + generate URL'}
							</Button>
						</ViewerTooltip>
					</div>
				</>
			)}

			{saved && !editing && (
				<>
					<MappingSummary ext={ext} />
					<SampleTester workspaceId={workspaceId} extensionId={ext.id} config={null} />
					<DeliveryHistory
						workspaceId={workspaceId}
						extensionId={ext.id}
						waiting={ext.committedDeliveries === 0}
						vendorName={ext.name}
					/>
				</>
			)}

			<AgentAccessSection ext={ext} workspaceId={workspaceId} />

			{reveal && (
				<WebhookRevealDialog
					open
					vendorName={ext.name}
					webhookUrl={reveal.webhookUrl}
					secret={reveal.secret}
					onDone={() => setReveal(null)}
				/>
			)}

			<Dialog open={confirmRegenerate} onOpenChange={setConfirmRegenerate}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Regenerate the webhook token?</DialogTitle>
						<DialogDescription>
							The current URL stops working immediately. {ext.name} will get a 404 until you paste
							the new URL into its webhook form.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter className="gap-2 sm:gap-0">
						<Button variant="ghost" onClick={() => setConfirmRegenerate(false)}>
							Cancel
						</Button>
						<ViewerTooltip>
							<Button
								variant="destructive"
								onClick={handleRegenerate}
								disabled={regenerate.isPending || !canWrite}
							>
								Regenerate token
							</Button>
						</ViewerTooltip>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	)
}

function describePath(v: { literal: string } | { path: string }): string {
	return 'path' in v ? v.path : v.literal
}

/** Read-only view of the saved mapping, shown while the form is closed. */
function MappingSummary({ ext }: { ext: ExtensionResponse }) {
	const map = ext.webhookConfig?.eventMap
	if (!map) return null
	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="mapping-summary-heading"
		>
			<h2 id="mapping-summary-heading" className="text-[13px] font-bold">
				Event mapping
			</h2>
			<dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
				<div>
					<dt className="text-muted-foreground">External ID (dedup key)</dt>
					<dd className="font-mono">{map.externalIdPath}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Entity type</dt>
					<dd className="font-mono">{describePath(map.entityType)}</dd>
				</div>
				<div>
					<dt className="text-muted-foreground">Action</dt>
					<dd className="font-mono">{describePath(map.action)}</dd>
				</div>
			</dl>
		</section>
	)
}
