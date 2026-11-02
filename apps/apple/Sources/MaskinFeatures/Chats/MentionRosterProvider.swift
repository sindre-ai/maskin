import MaskinCore
import SwiftUI

/// Everyone a composer can `@`-tag in the current workspace, built from the Members and Agents
/// stores. One per workspace, owned by `AppRuntime`, so every composer (thread, For you card reply,
/// Chief of Staff, object timeline) shows the same list with the same roles.
@MainActor
@Observable
final class MentionRosterProvider {
	let workspaceID: String
	private let members: MembersStore
	private let agents: AgentsStore
	@ObservationIgnored private var loading: Task<Void, Never>?

	init(members: MembersStore, agents: AgentsStore, workspaceID: String) {
		self.members = members
		self.agents = agents
		self.workspaceID = workspaceID
	}

	convenience init(environment: AppEnvironment, workspaceID: String) {
		self.init(
			members: SettingsServices(environment: environment).membersStore(),
			agents: AgentsStore(
				api: APIAgentsSource(client: environment.client, workspaceID: workspaceID),
				events: environment.events, cache: environment.snapshotCache),
			workspaceID: workspaceID)
	}

	/// Reads the observed stores, so a view that uses it redraws when either list arrives.
	var roster: MentionRoster {
		MentionRoster(members: members.members, agents: agents.agents)
	}

	/// Fetches both lists once; later calls join the first.
	func load() async {
		if let loading { return await loading.value }
		let task = Task { [members, agents] in
			async let a: Void = members.load()
			async let b: Void = agents.refresh()
			_ = await (a, b)
		}
		loading = task
		await task.value
	}
}
