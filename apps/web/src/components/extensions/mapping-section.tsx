import type {
	FieldMode,
	WebhookFormErrors,
	WebhookFormState,
} from '@/components/extensions/webhook-form'
import { FormError } from '@/components/shared/form-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/cn'

function ModeToggle({
	mode,
	onChange,
	name,
}: { mode: FieldMode; onChange: (m: FieldMode) => void; name: string }) {
	return (
		<fieldset className="inline-flex rounded-md border border-border p-0.5 text-xs">
			<legend className="sr-only">{name} source</legend>
			{(['literal', 'path'] as const).map((m) => (
				<button
					key={m}
					type="button"
					aria-pressed={mode === m}
					onClick={() => onChange(m)}
					className={cn(
						'rounded px-2 py-1 font-medium transition-colors',
						mode === m ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
					)}
				>
					{m === 'literal' ? 'Literal' : 'JSONPath'}
				</button>
			))}
		</fieldset>
	)
}

/**
 * Event mapping: three fields that turn a signed delivery into one events row.
 * External ID is always a JSONPath (it is the dedup key); Entity type and
 * Action can each be a fixed value or read from the payload.
 */
export function MappingSection({
	form,
	errors,
	onChange,
}: {
	form: WebhookFormState
	errors: WebhookFormErrors
	onChange: (next: WebhookFormState) => void
}) {
	const set = <K extends keyof WebhookFormState>(key: K, value: WebhookFormState[K]) =>
		onChange({ ...form, [key]: value })

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="mapping-heading"
		>
			<h2 id="mapping-heading" className="text-[13px] font-bold">
				Event mapping
			</h2>
			<p className="text-xs text-muted-foreground">
				How a signed delivery turns into an event a trigger can listen for.
			</p>

			<div className="mt-4 grid gap-4">
				<div className="grid gap-1.5">
					<Label htmlFor="external-id-path">External ID (dedup key)</Label>
					<Input
						id="external-id-path"
						value={form.externalIdPath}
						onChange={(e) => set('externalIdPath', e.target.value)}
						placeholder="$.meeting_id"
						className="font-mono"
						aria-invalid={!!errors.externalIdPath}
					/>
					<p className="text-xs text-muted-foreground">
						JSONPath into the delivery body. Must resolve to a string or number. A repeat delivery
						with the same value is ignored.
					</p>
					<FormError error={errors.externalIdPath} />
				</div>

				<div className="grid gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor="entity-type">Entity type</Label>
						<ModeToggle
							name="Entity type"
							mode={form.entityTypeMode}
							onChange={(m) => set('entityTypeMode', m)}
						/>
					</div>
					<Input
						id="entity-type"
						value={form.entityType}
						onChange={(e) => set('entityType', e.target.value)}
						placeholder={form.entityTypeMode === 'path' ? '$.type' : 'fireflies.transcript'}
						className="font-mono"
						aria-invalid={!!errors.entityType}
					/>
					<FormError error={errors.entityType} />
				</div>

				<div className="grid gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor="event-action">Action</Label>
						<ModeToggle
							name="Action"
							mode={form.actionMode}
							onChange={(m) => set('actionMode', m)}
						/>
					</div>
					<Input
						id="event-action"
						value={form.action}
						onChange={(e) => set('action', e.target.value)}
						placeholder={form.actionMode === 'path' ? '$.event' : 'ready'}
						className="font-mono"
						aria-invalid={!!errors.action}
					/>
					<p className="text-xs text-muted-foreground">
						A trigger listens for an entity type and action pair, for example fireflies.transcript
						and ready.
					</p>
					<FormError error={errors.action} />
				</div>
			</div>
		</section>
	)
}
