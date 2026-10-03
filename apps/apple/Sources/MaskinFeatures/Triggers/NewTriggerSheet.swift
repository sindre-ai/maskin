import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Create a scheduled trigger: name, schedule, agent and prompt. Event and reminder triggers are
/// set up on the web.
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
				Section("Name") { TextField("Morning brief", text: $draft.name) }
				Section("Schedule") { ScheduleEditor(schedule: $draft.schedule) }
				Section("Runs") {
					AgentPicker(
						title: "Agent", agents: store.directory.agents, selection: $draft.targetActorID)
					TextField("What should the agent do?", text: $draft.actionPrompt, axis: .vertical)
						.lineLimit(3...12)
				}
				if let error { Section { FormError(error) } }
			}
			.navigationTitle("New schedule")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Create") { Task { await create() } }.disabled(!draft.isValid || isCreating)
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
