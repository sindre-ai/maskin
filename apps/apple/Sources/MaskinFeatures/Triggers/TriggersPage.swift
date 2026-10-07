import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Triggers (1C), pushed from the profile sheet: what starts a flow on its own. Each row has a
/// switch (pause or resume) and opens its detail. "New trigger" opens the form sheet.
struct TriggersPage: View {
	let environment: AppEnvironment
	let workspaceID: String
	@State private var store: TriggersStore
	@State private var selected: String?
	@State private var showNew = false

	init(environment: AppEnvironment, workspaceID: String) {
		self.environment = environment
		self.workspaceID = workspaceID
		_store = State(
			initialValue: TriggersStore(
				api: APITriggersSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		WorkspacePage(title: "Triggers") {
			if let notice = store.notice {
				FormError(notice).onTapGesture { store.notice = nil }
			}
			if store.triggers.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "No triggers. Add one to start this flow on its own.")
				default: PageStatus(text: "Loading triggers")
				}
			} else {
				PageCard(rows: store.triggers.map(row))
				PageFootnote(text: "A trigger starts a flow on its own. Pause one and the flow keeps running by hand.")
			}
			Button("New trigger") { showNew = true }.buttonStyle(.primaryAction)
		}
		.navigationDestination(item: $selected) { id in
			if let trigger = store.trigger(id: id) {
				TriggerDetailPage(
					environment: environment, workspaceID: workspaceID, trigger: trigger, list: store,
					onGone: { selected = nil })
			}
		}
		.sheet(isPresented: $showNew) {
			NewTriggerSheet(store: store) { created in selected = created.id }
		}
		.task { await store.start() }
		.refreshable { await store.refresh() }
		.onDisappear { store.stop() }
	}

	private func row(_ trigger: Trigger) -> PageRowModel {
		PageRowModel(
			id: trigger.id, title: trigger.name,
			subtitle: WorkspacePageState.triggerSubtitle(trigger),
			accessory: .toggle(
				isOn: trigger.enabled, set: { on in Task { await store.setEnabled(trigger.id, on) } }),
			action: { selected = trigger.id })
	}
}

/// One trigger (1C detail): When, Then and the last three runs, with pause or resume and delete.
struct TriggerDetailPage: View {
	@State private var store: TriggerDetailStore
	@State private var confirmDelete = false
	@Environment(\.dismiss) private var dismiss
	let onGone: () -> Void

	init(
		environment: AppEnvironment, workspaceID: String, trigger: Trigger, list: TriggersStore,
		onGone: @escaping () -> Void
	) {
		let detail = TriggerDetailStore(
			trigger: trigger, directory: list.directory,
			api: APITriggersSource(client: environment.client, workspaceID: workspaceID),
			events: environment.events)
		detail.onSaved = { [list] saved in list.replace(saved) }
		detail.onDeleted = { [list] _ in Task { await list.refresh() } }
		_store = State(initialValue: detail)
		self.onGone = onGone
	}

	var body: some View {
		WorkspacePage(title: store.trigger.name) {
			PageGroupLabel(text: "When")
			PageCard(rows: [
				PageRowModel(
					id: "when", title: store.trigger.kind.label, subtitle: store.trigger.summary,
					accessory: .state(WorkspacePageState.trigger(enabled: store.trigger.enabled)))
			])
			PageGroupLabel(text: "Then")
			PageCard(rows: [
				PageRowModel(
					id: "then", title: store.agentName,
					subtitle: store.trigger.actionPrompt.isEmpty ? nil : store.trigger.actionPrompt)
			])
			PageGroupLabel(text: "Last 3 runs")
			if store.runs.isEmpty {
				PageStatus(text: "No runs yet.")
			} else {
				PageCard(rows: store.runs.map(runRow))
			}
			if let error = store.error { FormError(error) }
			Button(store.trigger.enabled ? "Pause" : "Resume") {
				Task { await store.setEnabled(!store.trigger.enabled) }
			}
			.buttonStyle(.primaryAction)
			Button("Delete trigger", role: .destructive) { confirmDelete = true }
				.buttonStyle(.secondaryAction)
		}
		.confirmationDialog("Delete trigger?", isPresented: $confirmDelete, titleVisibility: .visible) {
			Button("Delete trigger", role: .destructive) { Task { await store.delete() } }
		} message: {
			Text("The flow keeps running by hand.")
		}
		.onChange(of: store.isDeleted) { _, gone in if gone { onGone() } }
		.task { await store.start() }
		.onDisappear { store.stop() }
	}

	private func runRow(_ run: TriggerRun) -> PageRowModel {
		let state: PageState =
			switch run.outcome {
			case .ok: PageState("Done", .active)
			case .failed: PageState("Failed", .muted)
			case .running: PageState("Running", .plain)
			}
		return PageRowModel(
			id: run.id, title: run.at.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Run",
			accessory: .state(state))
	}
}
