import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The triggers (what wakes the agents), opened from the profile sheet or from a flow's detail. A
/// list and detail with its own "+": a trigger is a form with no chat path. Owns its split view
/// and a Done button.
struct TriggersSheet: View {
	let environment: AppEnvironment
	let workspaceID: String
	@State private var store: TriggersStore
	@State private var selection: String?
	@State private var showNew = false
	@Environment(\.dismiss) private var dismiss

	init(environment: AppEnvironment, workspaceID: String, initialSelection: String? = nil) {
		self.environment = environment
		self.workspaceID = workspaceID
		_selection = State(initialValue: initialSelection)
		_store = State(
			initialValue: TriggersStore(
				api: APITriggersSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		NavigationSplitView {
			TriggersListView(
				store: store, selection: $selection, search: "",
				isLive: environment.events.connection != .failed, onNew: { showNew = true }
			)
			.shellToolbar(environment: environment, title: "Triggers", actions: ShellActions(new: { showNew = true }, newLabel: "New trigger"))
			.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
			.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			if let id = selection, let trigger = store.trigger(id: id) {
				TriggerDetailHost(
					environment: environment, workspaceID: workspaceID, trigger: trigger, list: store,
					onGone: { selection = nil }
				)
				.id(id)
			} else {
				EmptyState(
					symbol: "bolt", title: "Select a trigger",
					message: "Turn it on or off, change its schedule, or create a new one.")
			}
		}
		.environment(\.shellShowsAvatar, false)
		.task { await store.start() }
		.onDisappear { store.stop() }
		.sheet(isPresented: $showNew) {
			NewTriggerSheet(store: store) { created in selection = created.id }
		}
	}
}

private struct TriggerDetailHost: View {
	@State private var store: TriggerDetailStore
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
		if store.isDeleted {
			EmptyState(symbol: "tray", title: "Trigger deleted")
				.onAppear(perform: onGone)
		} else {
			TriggerDetailView(store: store)
		}
	}
}
