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
			StandaloneStack {
				EmptyState(symbol: "person.2", title: "Choose a workspace")
					.shellToolbar(environment: environment, title: "Agents", actions: ShellActions())
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
	@Namespace private var zoom
	@Environment(\.isPushedInHostStack) private var pushed

	init(environment: AppEnvironment, workspaceID: String) {
		self.environment = environment
		_store = State(
			initialValue: AgentsStore(
				api: APIAgentsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache))
	}

	var body: some View {
		if pushed { pushedBody } else { splitBody }
	}

	/// Pushed onto the profile sheet's stack: the list, with an agent's detail pushed on top.
	private var pushedBody: some View {
		AgentListView(
			store: store, selection: $selection, search: $search,
			isLive: environment.events.connection != .failed, zoomNamespace: zoom
		)
		.shellToolbar(environment: environment, title: "Agents", actions: ShellActions())
		.navigationDestination(item: $selection) { id in
			AgentDetailHost(environment: environment, agentID: id) {
				store.remove(id: id)
				selection = nil
			}
			.id(id)
		}
		.task { await store.start() }
		.onDisappear { store.stop() }
	}

	private var splitBody: some View {
		NavigationSplitView {
			AgentListView(
				store: store, selection: $selection, search: $search,
				isLive: environment.events.connection != .failed, zoomNamespace: zoom
			)
			.shellToolbar(environment: environment, title: "Agents", actions: ShellActions())
			.navigationSplitViewColumnWidth(min: 300, ideal: 360, max: 440)
		} detail: {
			if let selection {
				AgentDetailHost(environment: environment, agentID: selection) {
					store.remove(id: selection)
					self.selection = nil
				}
				.id(selection)
				.zoomDestination(id: selection, in: zoom)
			} else {
				EmptyState(
					symbol: "person.2", title: "Select an agent",
					message: "See what each agent is doing and run it on demand.")
			}
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
