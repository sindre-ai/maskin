import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useExtensionSample } from '@/hooks/use-extensions'
import type { ExtensionSampleResult, ExtensionWebhookConfig } from '@/lib/api'
import { useState } from 'react'

/**
 * Dry run: paste a sample delivery body and see the event it would produce.
 * Runs the mapping only. Nothing is signed, claimed or committed.
 */
export function SampleTester({
	workspaceId,
	extensionId,
	config,
}: {
	workspaceId: string
	extensionId: string
	/** The config as currently filled in, when it is complete enough to test. */
	config: ExtensionWebhookConfig | null
}) {
	const sample = useExtensionSample(workspaceId, extensionId)
	const [payload, setPayload] = useState('')
	const [result, setResult] = useState<ExtensionSampleResult | null>(null)

	const run = async () => {
		setResult(null)
		const res = await sample.mutateAsync({
			payload,
			...(config ? { webhook_config: config } : {}),
		})
		setResult(res)
	}

	return (
		<section
			className="rounded-xl border border-border bg-card p-4"
			aria-labelledby="sample-heading"
		>
			<h2 id="sample-heading" className="text-[13px] font-bold">
				Test with a sample payload
			</h2>
			<p className="text-xs text-muted-foreground">
				Paste a real webhook body and we'll show the event it would produce. Nothing is saved or
				sent.
			</p>
			<div className="mt-3 grid gap-2">
				<Label htmlFor="sample-payload" className="sr-only">
					Sample payload
				</Label>
				<Textarea
					id="sample-payload"
					value={payload}
					onChange={(e) => setPayload(e.target.value)}
					placeholder='{"event":"meeting.transcribed","meeting_id":"abc123"}'
					className="min-h-28 font-mono text-xs"
				/>
				<div>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						onClick={run}
						disabled={!payload.trim() || sample.isPending}
					>
						Run sample
					</Button>
				</div>
				{sample.isError && (
					<p role="alert" className="text-xs text-error">
						Could not run the sample. Check the mapping fields above.
					</p>
				)}
				{result && !result.ok && (
					<p
						role="alert"
						className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
					>
						<strong>No event would be produced.</strong> {result.message}
					</p>
				)}
				{result?.ok && (
					<output className="block rounded-md border border-success/40 bg-success/10 px-3 py-2 text-xs">
						<p className="font-semibold">This delivery would create an event</p>
						<dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono">
							<dt className="text-muted-foreground">external id</dt>
							<dd className="break-all">{result.event.externalId}</dd>
							<dt className="text-muted-foreground">entity type</dt>
							<dd className="break-all">{result.event.entityType}</dd>
							<dt className="text-muted-foreground">action</dt>
							<dd className="break-all">{result.event.action}</dd>
						</dl>
					</output>
				)}
			</div>
		</section>
	)
}
