import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { TriangleAlert } from 'lucide-react'

/**
 * Reveal-once dialog (design-system/patterns/reveal-once.md): shows the webhook
 * URL and, when the page still holds it, the signing secret, each with a Copy
 * button. The only way out is the primary button; Escape and clicking outside
 * are disabled on purpose, because closing it by accident loses the secret.
 * The URL stays visible on the detail page afterwards, so only the secret
 * carries a never-shown-again warning.
 */
export function WebhookRevealDialog({
	open,
	onDone,
	vendorName,
	webhookUrl,
	secret,
}: {
	open: boolean
	onDone: () => void
	vendorName: string
	webhookUrl: string
	/** Omit after a token regeneration: the secret is not held anywhere to show again. */
	secret?: string
}) {
	const both = `${webhookUrl}\n${secret}`
	return (
		<Dialog open={open}>
			<DialogContent
				onEscapeKeyDown={(e) => e.preventDefault()}
				onPointerDownOutside={(e) => e.preventDefault()}
				onInteractOutside={(e) => e.preventDefault()}
				className="max-h-[100dvh] overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:h-[100dvh] max-sm:content-start max-sm:w-full max-sm:max-w-none max-sm:translate-y-0 max-sm:rounded-none [&>button.absolute]:hidden"
			>
				<DialogHeader>
					<DialogTitle>Paste these into {vendorName}</DialogTitle>
					<DialogDescription>
						{secret
							? `Two values you'll need in the ${vendorName} webhook form. We show them once. Copy them now.`
							: `The new webhook URL for ${vendorName}. The old URL has stopped working.`}
					</DialogDescription>
				</DialogHeader>

				<div className="grid gap-1.5">
					<Label htmlFor="reveal-webhook-url">Webhook URL</Label>
					<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
						<code
							id="reveal-webhook-url"
							className="block min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
						>
							{webhookUrl}
						</code>
						<CopyButton
							text={webhookUrl}
							label
							ariaLabel="Copy webhook URL"
							className="max-sm:w-full"
						/>
					</div>
					<p className="text-xs text-muted-foreground">
						Paste this into the webhook form in {vendorName}'s dashboard.
					</p>
				</div>

				{secret && (
					<div className="grid gap-1.5">
						<Label htmlFor="reveal-signing-secret">Signing secret</Label>
						<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
							<code
								id="reveal-signing-secret"
								className="block min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-xs"
							>
								{secret}
							</code>
							<CopyButton
								text={secret}
								label
								ariaLabel="Copy signing secret"
								className="max-sm:w-full"
							/>
						</div>
						<p className="text-xs text-muted-foreground">
							{vendorName} signs every delivery with this secret, and we reject any that do not
							match.
						</p>
					</div>
				)}

				{secret && (
					<p
						role="note"
						className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground"
					>
						<TriangleAlert size={14} className="mt-0.5 shrink-0" aria-hidden />
						<span>
							<strong>You won't see the secret again after this dialog closes.</strong> If you lose
							it, edit the webhook and generate a new one.
						</span>
					</p>
				)}

				<DialogFooter className="gap-2 sm:gap-0">
					{secret && (
						<CopyButton
							text={both}
							label="Copy both"
							ariaLabel="Copy both"
							className="max-sm:w-full"
						/>
					)}
					<Button type="button" onClick={onDone} className="max-sm:w-full">
						I've saved them in {vendorName}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
