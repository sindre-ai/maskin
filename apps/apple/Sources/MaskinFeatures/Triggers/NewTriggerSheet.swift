import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// New trigger (2G): When it starts (a schedule or an event) and Then what runs. Save stays off
/// until both are set. Reminders are set up on the web.
struct NewTriggerSheet: View {
	let store: TriggersStore
	let onCreated: (Trigger) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var draft = TriggerDraft()
	@State private var isCreating = false
	@State private var error: String?

	var body: some View {
		NavigationStack {
			Form {
				Section {
					Picker("Start on", selection: $draft.whenKind) {
						ForEach(TriggerWhenKind.allCases) { Text($0.label).tag($0) }
					}
					.pickerStyle(.segmented)
					switch draft.whenKind {
					case .schedule:
						ScheduleEditor(schedule: $draft.schedule)
					case .event:
						Picker("Event", selection: $draft.event) {
							if draft.event == nil { Text("Choose an event").tag(TriggerEventRule?.none) }
							ForEach(TriggerEventRule.options) { Text($0.plainName).tag(TriggerEventRule?.some($0)) }
						}
					}
				} header: {
					Text("When")
				}
				Section {
					AgentPicker(
						title: "Agent", agents: store.directory.agents, selection: $draft.targetActorID)
					TextField("What should the agent do?", text: $draft.actionPrompt, axis: .vertical)
						.lineLimit(3...12)
				} header: {
					Text("Then")
				}
				Section {
					TextField("Optional", text: $draft.name)
				} header: {
					Text("Name")
				}
				if let error { Section { FormError(error) } }
			}
			.navigationTitle("New trigger")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Save") { Task { await create() } }.disabled(!draft.isValid || isCreating)
				}
			}
			.overlay { if isCreating { ProgressView() } }
			.task { await store.loadActors() }
		}
	}

	private func create() async {
		isCreating = true
		error = nil
		defer { isCreating = false }
		do {
			let made = try await store.create(draft)
			onCreated(made)
			dismiss()
		} catch {
			self.error = AutomationErrorText.message(error)
		}
	}
}

enum AutomationErrorText {
	static func message(_ error: Error) -> String {
		(error as? AutomationError)?.message ?? "Couldn't create the trigger. Check your connection."
	}
}
