import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One trigger: what fires it, who runs it, the prompt, and the fields that can be edited here.
struct TriggerDetailView: View {
	@Bindable var store: TriggerDetailStore
	@State private var confirmDelete = false

	var body: some View {
		Form {
			Section {
				Toggle(
					"Enabled",
					isOn: Binding(
						get: { store.trigger.enabled }, set: { on in Task { await store.setEnabled(on) } }))
			} footer: {
				if let next = store.nextRun() {
					// `next` is an absolute instant, so the system formatter shows it in the viewer's zone.
					Text("Next run \(next.formatted(date: .abbreviated, time: .shortened)) your time")
				} else if !store.trigger.enabled {
					Text("Off. This trigger won't fire until you turn it on.")
				}
			}
			Section("Name") {
				TextField("Name", text: $store.edit.name)
			}
			Section("When") {
				switch store.trigger.kind {
				case .cron:
					if store.edit.schedule != nil {
						ScheduleEditor(
							schedule: Binding(
								get: { store.edit.schedule ?? CronSchedule() },
								set: { store.edit.schedule = $0 }))
					} else {
						LabeledContent("Schedule", value: store.trigger.cronExpression ?? "Custom")
						Text("This schedule uses cron syntax the app can't edit. Change it on the web.")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					}
				default:
					LabeledContent(store.trigger.kind.label) {
						Text(store.trigger.summary).multilineTextAlignment(.trailing)
					}
					Text("Edit this rule on the web.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
			Section("Runs") {
				Picker("Agent", selection: $store.edit.targetActorID) {
					if !store.directory.agents.contains(where: { $0.id == store.edit.targetActorID }) {
						Text(store.directory.name(store.edit.targetActorID) ?? "Unknown agent")
							.tag(store.edit.targetActorID)
					}
					ForEach(store.directory.agents) { Text($0.name).tag($0.id) }
				}
				TextField("What should the agent do?", text: $store.edit.actionPrompt, axis: .vertical)
					.lineLimit(3...12)
			}
			if let error = store.error {
				Section { FormError(error) }
			}
			Section {
				Button("Delete trigger", role: .destructive) { confirmDelete = true }
			}
		}
		.navigationTitle(store.trigger.name)
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			if store.isDirty {
				ToolbarItem(placement: .cancellationAction) {
					Button("Discard") { store.discardChanges() }
				}
			}
			ToolbarItem(placement: .confirmationAction) {
				Button("Save") { Task { await store.save() } }.disabled(!store.canSave)
			}
		}
		.overlay { if store.isSaving { ProgressView() } }
		.confirmationDialog(
			"Delete \(store.trigger.name)?", isPresented: $confirmDelete, titleVisibility: .visible
		) {
			Button("Delete trigger", role: .destructive) { Task { await store.delete() } }
		} message: {
			Text("Agents will no longer be woken by it.")
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
	}
}
