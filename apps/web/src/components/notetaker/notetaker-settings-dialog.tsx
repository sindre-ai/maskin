import { Button } from '@/components/ui/button'
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useConnectIntegration, useIntegrations } from '@/hooks/use-integrations'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { MODULE_ID, MODULE_NAME } from '@maskin/ext-notetaker/shared'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'

interface NotetakerConfig {
	autoJoin: boolean
	defaultLanguage: string
	botName: string
	syncIntervalMinutes: number
}

const DEFAULT_CONFIG: NotetakerConfig = {
	autoJoin: true,
	defaultLanguage: 'en',
	botName: 'Maskin Notetaker',
	syncIntervalMinutes: 10,
}

const LANGUAGE_OPTIONS = [
	{ value: 'en', label: 'English' },
	{ value: 'nb', label: 'Norwegian (Bokmål)' },
	{ value: 'da', label: 'Danish' },
	{ value: 'sv', label: 'Swedish' },
	{ value: 'de', label: 'German' },
	{ value: 'fr', label: 'French' },
	{ value: 'es', label: 'Spanish' },
]

const CALENDAR_PROVIDERS = [
	{ name: 'google-calendar', label: 'Connect Google Calendar' },
	{ name: 'microsoft-outlook', label: 'Connect Outlook' },
] as const

interface NotetakerSettingsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

export function NotetakerSettingsDialog({ open, onOpenChange }: NotetakerSettingsDialogProps) {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const connectIntegration = useConnectIntegration(workspaceId)
	const { data: integrations } = useIntegrations(workspaceId)

	const settings = (workspace.settings as Record<string, unknown>) ?? {}
	const customExtensions =
		(settings.custom_extensions as Record<string, { config?: Partial<NotetakerConfig> }>) ?? {}
	const storedConfig = customExtensions[MODULE_ID]?.config ?? {}

	const [form, setForm] = useState<NotetakerConfig>({ ...DEFAULT_CONFIG, ...storedConfig })
	const [intervalText, setIntervalText] = useState(
		String({ ...DEFAULT_CONFIG, ...storedConfig }.syncIntervalMinutes),
	)

	// Reset form to current stored values when the dialog re-opens.
	useEffect(() => {
		if (open) {
			const next = { ...DEFAULT_CONFIG, ...storedConfig }
			setForm(next)
			setIntervalText(String(next.syncIntervalMinutes))
		}
	}, [open, storedConfig])

	const connectedProviders = new Set(
		(integrations ?? []).filter((i) => i.status === 'active').map((i) => i.provider),
	)

	const handleSave = () => {
		const parsedInterval = Number(intervalText)
		const syncIntervalMinutes =
			Number.isFinite(parsedInterval) && parsedInterval >= 1 && parsedInterval <= 60
				? Math.floor(parsedInterval)
				: DEFAULT_CONFIG.syncIntervalMinutes

		const botName = form.botName.trim() || DEFAULT_CONFIG.botName
		const defaultLanguage = form.defaultLanguage.trim() || DEFAULT_CONFIG.defaultLanguage

		const nextExtensions = { ...customExtensions }
		const existingEntry = (nextExtensions[MODULE_ID] as Record<string, unknown> | undefined) ?? {
			name: MODULE_NAME,
			types: ['meeting'],
			enabled: true,
		}
		const existingConfig = (existingEntry.config as Record<string, unknown> | undefined) ?? {}
		nextExtensions[MODULE_ID] = {
			...existingEntry,
			config: {
				...existingConfig,
				autoJoin: form.autoJoin,
				defaultLanguage,
				botName,
				syncIntervalMinutes,
			},
		}

		updateWorkspace.mutate(
			{ settings: { ...settings, custom_extensions: nextExtensions } },
			{
				onSuccess: () => {
					toast.success('Notetaker settings saved')
					onOpenChange(false)
				},
				onError: () => toast.error('Failed to save notetaker settings'),
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Notetaker settings</DialogTitle>
					<DialogDescription>
						Configure how the notetaker joins meetings and syncs calendar events.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-5 py-2">
					<div className="flex items-center justify-between gap-4">
						<div>
							<Label className="text-sm font-medium">Auto-join meetings</Label>
							<p className="text-xs text-muted-foreground mt-1">
								Automatically send a bot to scheduled meetings from connected calendars.
							</p>
						</div>
						<Switch
							checked={form.autoJoin}
							onCheckedChange={(checked) => setForm((prev) => ({ ...prev, autoJoin: !!checked }))}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="notetaker-language" className="text-muted-foreground">
							Default language
						</Label>
						<Select
							value={form.defaultLanguage}
							onValueChange={(v) => setForm((prev) => ({ ...prev, defaultLanguage: v }))}
						>
							<SelectTrigger id="notetaker-language" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{LANGUAGE_OPTIONS.map((opt) => (
									<SelectItem key={opt.value} value={opt.value}>
										{opt.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					<div className="space-y-2">
						<Label htmlFor="notetaker-bot-name" className="text-muted-foreground">
							Bot name
						</Label>
						<Input
							id="notetaker-bot-name"
							type="text"
							value={form.botName}
							onChange={(e) => setForm((prev) => ({ ...prev, botName: e.target.value }))}
							placeholder={DEFAULT_CONFIG.botName}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="notetaker-sync-interval" className="text-muted-foreground">
							Calendar sync interval (minutes)
						</Label>
						<Input
							id="notetaker-sync-interval"
							type="number"
							min={1}
							max={60}
							value={intervalText}
							onChange={(e) => setIntervalText(e.target.value)}
						/>
					</div>

					<div className="space-y-2 border-t border-border pt-4">
						<Label className="text-muted-foreground">Calendar integrations</Label>
						<div className="flex flex-col gap-2">
							{CALENDAR_PROVIDERS.map((provider) => {
								const isConnected = connectedProviders.has(provider.name)
								return (
									<Button
										key={provider.name}
										variant="outline"
										className="justify-between"
										onClick={() => connectIntegration.mutate(provider.name)}
										disabled={connectIntegration.isPending}
									>
										<span>{provider.label}</span>
										{isConnected && <span className="text-xs text-success">Connected</span>}
									</Button>
								)
							})}
						</div>
					</div>
				</div>

				<DialogFooter>
					<Button variant="ghost" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button onClick={handleSave} disabled={updateWorkspace.isPending}>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	)
}
