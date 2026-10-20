import Foundation

/// Ties the "Agents working" activity to the signed-in workspace: one `WorkingAgentsFeed` per
/// workspace, rebuilt on every sign-in or workspace switch, torn down on sign-out. The app's
/// foreground and background refresh hooks call `refresh()`.
@MainActor
public final class AgentsActivityRuntime {
	/// The app's runtime, set at launch on iOS; `nil` where Live Activities don't exist.
	public static var shared: AgentsActivityRuntime?

	public let coordinator: AgentsActivityCoordinator
	private let makeFeed: @MainActor (_ workspaceId: String, _ coordinator: AgentsActivityCoordinator) -> WorkingAgentsFeed
	private(set) var feed: WorkingAgentsFeed?
	private(set) var workspaceId: String?

	public init(
		coordinator: AgentsActivityCoordinator,
		makeFeed: @escaping @MainActor (_ workspaceId: String, _ coordinator: AgentsActivityCoordinator) -> WorkingAgentsFeed
	) {
		self.coordinator = coordinator
		self.makeFeed = makeFeed
	}

	/// Production wiring over the app environment.
	public convenience init(environment: AppEnvironment, coordinator: AgentsActivityCoordinator) {
		self.init(coordinator: coordinator) { workspaceId, coordinator in
			WorkingAgentsFeed(
				api: APIAgentsSource(client: environment.client, workspaceID: workspaceId),
				events: environment.events
			) { agents in await coordinator.feedChanged(agents) }
		}
	}

	/// The signed-in workspace changed (nil: signed out). Idempotent.
	public func sessionChanged(workspaceId: String?) async {
		guard workspaceId != self.workspaceId else { return }
		feed?.stop()
		feed = nil
		self.workspaceId = workspaceId
		await coordinator.workspaceChanged(workspaceId)
		guard let workspaceId else { return }
		let next = makeFeed(workspaceId, coordinator)
		feed = next
		await next.start()
		await coordinator.sweep()
	}

	/// Refetch the running sessions now (app came to the foreground, background refresh).
	public func refresh() async {
		await feed?.refresh()
		await coordinator.sweep()
	}
}
