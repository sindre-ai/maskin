import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `WidgetDataSource`: the For You backend plus one notifications request, on a client
/// that carries the credentials the widget read from the shared Keychain.
public struct APIWidgetDataSource: WidgetDataSource {
	private let client: Client
	private let forYou: APIForYouBackend

	public init(client: Client, workspaceId: String) {
		self.client = client
		self.forYou = APIForYouBackend(client: client, workspaceId: { workspaceId })
	}

	/// A client for one session. `onUnauthorized` raises the flag the loader checks.
	public static func make(
		baseURL: URL, session: StoredSession, flag: WidgetUnauthorizedFlag
	) -> APIWidgetDataSource {
		let credentials = MaskinCredentials(apiKey: session.apiKey, workspaceId: session.workspaceId)
		let client = MaskinClient.make(
			serverURL: baseURL, clientSource: "ios", credentials: { credentials },
			onUnauthorized: { _ in flag.raise() })
		return APIWidgetDataSource(client: client, workspaceId: session.workspaceId ?? "")
	}

	public func feed(workspaceId: String) async throws -> [ForYouCard] {
		try await forYou.fetchFeed(workspaceId: workspaceId)
	}

	public func actors(workspaceId: String) async throws -> [ForYouActor] {
		try await forYou.fetchActors(workspaceId: workspaceId)
	}

	/// One page of `status=pending`: the same rows `NotificationsStore.unreadCount` counts.
	public func unreadNotificationCount(workspaceId: String) async throws -> Int {
		let output = try await client.get_sol_api_sol_notifications(
			query: .init(status: "pending", limit: WidgetSnapshot.unreadCap),
			headers: .init(x_hyphen_workspace_hyphen_id: workspaceId))
		guard case .ok(let ok) = output else { throw ForYouLoadError("Couldn't load notifications.") }
		return try ok.body.json.count
	}
}

extension WidgetSnapshotLoader {
	/// The loader the extension uses: shared-group Keychain session, own-container cache, real API.
	public static func live(baseURL: URL) -> WidgetSnapshotLoader {
		WidgetSnapshotLoader(
			secrets: KeychainSecretStore(), cache: FileWidgetSnapshotCache(),
			makeSource: { session, flag in
				APIWidgetDataSource.make(baseURL: baseURL, session: session, flag: flag)
			})
	}
}
