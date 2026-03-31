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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useUpdateWorkspace } from '@/hooks/use-workspaces'
import { useWorkspace } from '@/lib/workspace-context'
import { useState } from 'react'
import { toast } from 'sonner'

interface NotetakerSettingsDialogProps {
	open: boolean
	onOpenChange: (open: boolean) => void
}

interface BotConfig {
	bot_name?: string
	bot_image?: string
	entry_message?: string
}

interface NotetakerSettings {
	auto_join_mode: 'all' | 'organized_by_me' | 'manual'
	language: string
	bot_config?: BotConfig
}

export function NotetakerSettingsDialog({ open, onOpenChange }: NotetakerSettingsDialogProps) {
	const { workspace, workspaceId } = useWorkspace()
	const updateWorkspace = useUpdateWorkspace(workspaceId)
	const settings = workspace.settings as Record<string, unknown>
	const current = (settings?.notetaker_settings as NotetakerSettings) ?? {
		auto_join_mode: 'all',
		language: '',
		bot_config: {},
	}

	const [autoJoinMode, setAutoJoinMode] = useState<string>(current.auto_join_mode)
	const [language, setLanguage] = useState(current.language)
	const [botName, setBotName] = useState(current.bot_config?.bot_name ?? '')
	const [botImage, setBotImage] = useState(current.bot_config?.bot_image ?? '')
	const [entryMessage, setEntryMessage] = useState(current.bot_config?.entry_message ?? '')

	const handleSave = () => {
		updateWorkspace.mutate(
			{
				settings: {
					...settings,
					notetaker_settings: {
						auto_join_mode: autoJoinMode,
						language,
						bot_config: {
							bot_name: botName || undefined,
							bot_image: botImage || undefined,
							entry_message: entryMessage || undefined,
						},
					},
				},
			},
			{
				onSuccess: () => {
					toast.success('Notetaker settings saved')
					onOpenChange(false)
				},
				onError: () => toast.error('Failed to save settings'),
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[425px]">
				<DialogHeader>
					<DialogTitle>Notetaker Settings</DialogTitle>
					<DialogDescription>
						Configure how the notetaker joins and records meetings.
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					<div className="space-y-2">
						<Label htmlFor="bot-name">Bot name</Label>
						<Input
							id="bot-name"
							placeholder="Sindre"
							value={botName}
							onChange={(e) => setBotName(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="bot-image">Bot image URL</Label>
						<Input
							id="bot-image"
							placeholder="https://example.com/avatar.png"
							value={botImage}
							onChange={(e) => setBotImage(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label htmlFor="entry-message">Entry message</Label>
						<Input
							id="entry-message"
							placeholder="Message shown when bot joins (optional)"
							value={entryMessage}
							onChange={(e) => setEntryMessage(e.target.value)}
						/>
					</div>

					<div className="space-y-2">
						<Label>Auto-join mode</Label>
						<RadioGroup value={autoJoinMode} onValueChange={setAutoJoinMode}>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="all" id="all" />
								<Label htmlFor="all" className="font-normal">
									All meetings with video links
								</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="organized_by_me" id="organized_by_me" />
								<Label htmlFor="organized_by_me" className="font-normal">
									Only meetings I organize
								</Label>
							</div>
							<div className="flex items-center space-x-2">
								<RadioGroupItem value="manual" id="manual" />
								<Label htmlFor="manual" className="font-normal">
									Manual only (no auto-join)
								</Label>
							</div>
						</RadioGroup>
					</div>

					<div className="space-y-2">
						<Label htmlFor="language">Transcription language</Label>
						<Input
							id="language"
							placeholder="Auto-detect (leave empty)"
							value={language}
							onChange={(e) => setLanguage(e.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							ISO language code (e.g. en, no, de). Leave empty for auto-detection.
						</p>
					</div>
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
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
