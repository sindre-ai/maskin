import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

/// Everything a screen needs, passed down once: `ForYouScreen(environment:)`. Holds long-lived
/// stores and the network client; screens read from it and never construct their own.
///
/// - `client` is the generated OpenAPI client already carrying the credentials, workspace header
///   and `X-Client-Source`. Wrap it in a private per-store adapter; never use generated operation
///   names outside that adapter.
/// - `events` is the shared real-time hub. Subscribe once per store.
/// - Writes that must be replayable go through `IdempotencyKey.$current.withValue(_:)`.
@MainActor
public final class AppEnvironment {
	public let baseURL: URL
	public let clientSource: String
	public let auth: AuthSession
	public let workspaces: WorkspaceStore
	public let client: Client
	public let events: EventHub

	public init(
		baseURL: URL, clientSource: String, auth: AuthSession, workspaces: WorkspaceStore,
		client: Client, events: EventHub
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.auth = auth
		self.workspaces = workspaces
		self.client = client
		self.events = events
	}

	/// The real wiring. `clientSource` is `ios` / `macos` / `watchos` / `tvos`.
	public convenience init(
		baseURL: URL, clientSource: String, secretStore: any SecretStore
	) {
		let auth = AuthSession(
			authenticator: APIAuthenticator(serverURL: baseURL, clientSource: clientSource),
			store: secretStore, signOutMarker: UserDefaultsSignOutMarker())
		let credentials = auth.credentialsProvider
		// A 401 on any request, or on the event stream, ends the session in one place.
		let client = MaskinClient.make(
			serverURL: baseURL, clientSource: clientSource, credentials: credentials,
			onUnauthorized: { [weak auth] key in await auth?.sessionRejected(apiKey: key) })
		let events = EventHub(baseURL: baseURL, clientSource: clientSource, credentials: credentials)
		events.onUnauthorized = { [weak auth] key in
			// The key the refused stream was opened with — not the current one (see EventHub).
			if let key { auth?.sessionRejected(apiKey: key) }
		}
		self.init(
			baseURL: baseURL, clientSource: clientSource, auth: auth,
			workspaces: WorkspaceStore(
				source: APIWorkspaceSource(client: client), auth: auth, disk: .shared),
			client: client, events: events)
	}

	/// The selected workspace id, if signed in.
	public var workspaceId: String? { auth.session?.workspaceId }

	/// Called by the shell whenever the signed-in user or workspace changes: points the event
	/// stream at the current workspace, or stops it when signed out.
	public func syncEvents() {
		events.connect(workspaceId: workspaceId, credentialKey: auth.session?.apiKey)
	}

	public func signOut() {
		auth.signOut()
		workspaces.reset()
		events.disconnect()
	}
}

// MARK: - Previews and tests

private struct NoAuthenticator: Authenticating {
	func login(email: String, password: String) async throws -> LoginResult {
		throw AuthError.network("Preview environment has no server.")
	}
}

extension AppEnvironment {
	/// Offline environment for `#Preview` and tests: in-memory session, a fixed workspace list,
	/// an inert event hub, and a client pointed at a URL nothing listens on.
	public static func preview(
		signedIn: Bool = true,
		workspaces list: [WorkspaceSummary] = [
			WorkspaceSummary(id: "ws-1", name: "Mesh Firm", role: "owner", memberCount: 4),
			WorkspaceSummary(id: "ws-2", name: "Side Project", role: "member", memberCount: 2),
		]
	) -> AppEnvironment {
		let url = URL(string: "http://localhost:3000")!
		let store = InMemorySecretStore()
		if signedIn {
			let stored = StoredSession(
				apiKey: "ank_preview", actorId: "actor-1", name: "Alex Preview",
				email: "alex@example.com", workspaceId: list.first?.id)
			try? store.write(try! JSONEncoder().encode(stored))
		}
		let auth = AuthSession(authenticator: NoAuthenticator(), store: store)
		auth.restore()
		let client = MaskinClient.make(
			serverURL: url, clientSource: "preview", credentials: auth.credentialsProvider)
		let workspaces = WorkspaceStore(source: StaticWorkspaceSource(list), auth: auth)
		return AppEnvironment(
			baseURL: url, clientSource: "preview", auth: auth, workspaces: workspaces,
			client: client, events: EventHub(client: nil))
	}
}
