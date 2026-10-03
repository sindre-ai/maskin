import MaskinAPI
import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The Agents tab. A `NavigationSplitView`: list + detail side by side on iPad and Mac, a push
/// stack on iPhone. Owns its navigation and applies the shell toolbar.
public struct AgentsScreen: View {
	private let environment: AppEnvironment

	public init(environment: AppEnvironment) {
		self.environment = environment
	}

	public var body: some View {
		if let workspaceID = environment.workspaceId {
			// Rebuilt per workspace so no agent from the previous one lingers.
			AgentsContainer(environment: environment, workspaceID: workspaceID)
				.id(workspaceID)
		} else {
			NavigationStack {
				EmptyState(symbol: "person.2", title: "Choose a workspace")
					.navigationTitle("Agents")
					.shellToolbar(environment: environment)
			}
		}
	}
}

/// One agent's detail on its own, for other screens to navigate to (a chat participant, a
/// session's owner). Wrap in the caller's navigation; pushes nothing itself.
public struct AgentDetailScreen: View {
	private let environment: AppEnvironment
	private let agentId: String
	@Environment(\.dismiss) private var dismiss

	public init(environment: AppEnvironment, agentId: String) {
		self.environment = environment
		self.agentId = agentId
	}

	public var body: some View {
		AgentDetailHost(environment: environment, agentID: agentId) { dismiss() }
			.id("\(environment.workspaceId ?? "")/\(agentId)")
	}
}

private struct AgentsContainer: View {
	let environment: AppEnvironment
	@State private var store: AgentsStore
	@State private var selection: String?
	@State private var search = ""
	@State private var showCreate = false

	init(environment: AppEnvironment, workspaceID: String) {
		self.environment = environment
		_store = State(
			initialValue: AgentsStore(
				api: APIAgentsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		NavigationSplitView {
			AgentListView(
				store: store, selection: $selection, search: $search,
				isLive: environment.events.connection != .failed
			)
			.toolbar {
				ToolbarItem(placement: .primaryAction) {
					Button { showCreate = true } label: { Image(systemName: "plus") }
						.accessibilityLabel("New agent")
				}
			}
			.shellToolbar(environment: environment)
			.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			if let selection {
				AgentDetailHost(environment: environment, agentID: selection) {
					store.remove(id: selection)
					self.selection = nil
				}
				.id(selection)
			} else {
				EmptyState(
					symbol: "person.2", title: "Select an agent",
					message: "See what each agent is doing and run it on demand.")
			}
		}
		.sheet(isPresented: $showCreate, onDismiss: { store.notice = nil }) {
			AgentFormSheet(mode: .create, errorMessage: store.notice) { draft in
				guard let id = await store.create(draft) else { return false }
				selection = id
				return true
			}
			.presentationDetents([.large])
			.presentationCornerRadius(MaskinRadius.hero + MaskinSpace.s4)
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
	}
}

/// Builds the `AgentDetailStore` for one agent and starts it.
private struct AgentDetailHost: View {
	let environment: AppEnvironment
	var onDeleted: () -> Void = {}
	@State private var store: AgentDetailStore

	init(environment: AppEnvironment, agentID: String, onDeleted: @escaping () -> Void = {}) {
		self.environment = environment
		self.onDeleted = onDeleted
		_store = State(
			initialValue: AgentDetailStore(
				agentID: agentID,
				api: APIAgentsSource(client: environment.client, workspaceID: environment.workspaceId ?? ""),
				events: environment.events))
	}

	var body: some View {
		AgentDetailView(store: store, onDeleted: onDeleted)
			.task { await store.start() }
			.onDisappear { store.stop() }
	}
}
