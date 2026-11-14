import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One integration's agent access (v3 GitHub page): each agent with its level. Tap an agent to
/// choose Read, Read & write or No access.
struct IntegrationAccessView: View {
	@State private var store: IntegrationAccessStore
	@State private var target: IntegrationAccessStore.AgentRef?
	let title: String
	/// Granted and requested permissions above the agent list (nil hides them).
	let scopes: IntegrationScopesStore?
	/// The watched folders, on the Google Drive page only (nil elsewhere).
	let driveWatches: DriveWatchesStore?
	let onReconnect: (() -> Void)?

	init(
		store: IntegrationAccessStore, title: String, scopes: IntegrationScopesStore? = nil,
		driveWatches: DriveWatchesStore? = nil, onReconnect: (() -> Void)? = nil
	) {
		_store = State(initialValue: store)
		self.title = title
		self.scopes = scopes
		self.driveWatches = driveWatches
		self.onReconnect = onReconnect
	}

	var body: some View {
		WorkspacePage(title: title) {
			if let scopes { IntegrationScopesBlock(store: scopes, providerName: title, onReconnect: onReconnect) }
			if let driveWatches { DriveWatchesBlock(store: driveWatches) }
			switch store.phase {
			case .loaded:
				if store.agents.isEmpty {
					PageStatus(text: "No agents in this workspace yet.")
				} else {
					PageGroupLabel(text: "Agent access")
					PageCard(rows: store.agents.map(row))
				}
				if let error = store.actionError { FormError(error) }
				PageFootnote(
					text: store.canManage
						? "Applies to sessions that start after you change it."
						: "Only owners and admins can change agent access.")
			case .failed(let message): PageStatus(text: message)
			default: PageStatus(text: "Loading agent access")
			}
		}
		.task {
			await scopes?.load()
			await driveWatches?.load()
			await store.load()
		}
		.refreshable {
			await scopes?.load()
			await driveWatches?.load()
			await store.load()
		}
		.confirmationDialog(
			target?.name ?? "Agent",
			isPresented: Binding(get: { target != nil }, set: { if !$0 { target = nil } }),
			titleVisibility: .visible, presenting: target
		) { agent in
			ForEach([AgentAccess.readWrite, .read, .none], id: \.self) { level in
				Button(level.label) { Task { await store.set(level, for: agent) } }
			}
		}
	}

	private func row(_ agent: IntegrationAccessStore.AgentRef) -> PageRowModel {
		let level = store.access(for: agent.id)
		return PageRowModel(
			id: agent.id, title: agent.name, avatar: (agent.name, true),
			accessory: .state(
				store.busyIDs.contains(agent.id)
					? PageState("Saving", .muted) : PageState(level.label, level == .none ? .muted : .active)),
			action: store.canManage ? { target = agent } : nil)
	}
}
