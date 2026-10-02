import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

public struct WorkspaceSummary: Identifiable, Sendable, Equatable {
	public var id: String
	public var name: String
	/// The signed-in actor's role in it (`owner`, `member`, …).
	public var role: String
	public var memberCount: Int

	public init(id: String, name: String, role: String, memberCount: Int) {
		self.id = id
		self.name = name
		self.role = role
		self.memberCount = memberCount
	}
}

/// `GET /api/workspaces`. A protocol so the store tests without a server.
public protocol WorkspaceListing: Sendable {
	func listWorkspaces() async throws -> [WorkspaceSummary]
}

/// Fixed list, for previews and tests.
public struct StaticWorkspaceSource: WorkspaceListing {
	public var result: Result<[WorkspaceSummary], WorkspaceListingError>
	public init(_ workspaces: [WorkspaceSummary]) { result = .success(workspaces) }
	public init(failure: WorkspaceListingError) { result = .failure(failure) }
	public func listWorkspaces() async throws -> [WorkspaceSummary] { try result.get() }
}

public struct WorkspaceListingError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}

/// Production source: the generated client behind a private adapter, so operation names never
/// leak out of this file.
public struct APIWorkspaceSource: WorkspaceListing {
	private let client: Client
	public init(client: Client) { self.client = client }

	public func listWorkspaces() async throws -> [WorkspaceSummary] {
		let output = try await client.get_sol_api_sol_workspaces()
		switch output {
		case .ok(let ok):
			return try ok.body.json.map {
				WorkspaceSummary(id: $0.id, name: $0.name, role: $0.role, memberCount: $0.memberCount)
			}
		default:
			throw WorkspaceListingError("Couldn't load workspaces.")
		}
	}
}

/// The actor's workspaces and which one is selected. Selection lives in `AuthSession` (it is part
/// of the persisted credentials and the `X-Workspace-Id` header), this store reflects it and keeps
/// it valid: when nothing is selected, or the selection is no longer in the list, it picks the
/// first workspace.
@MainActor
@Observable
public final class WorkspaceStore {
	public enum Phase: Equatable, Sendable {
		case idle
		case loading
		case loaded
		case failed(String)
	}

	public private(set) var workspaces: [WorkspaceSummary] = []
	public private(set) var phase: Phase = .idle

	@ObservationIgnored private let source: any WorkspaceListing
	@ObservationIgnored private let auth: AuthSession
	/// Bumped on `reset()` and every `refresh()`; only the latest load for the same actor may write.
	@ObservationIgnored private var generation = 0

	public init(source: any WorkspaceListing, auth: AuthSession) {
		self.source = source
		self.auth = auth
	}

	public var selectedID: String? { auth.session?.workspaceId }

	public var selected: WorkspaceSummary? {
		workspaces.first { $0.id == selectedID }
	}

	public func refresh() async {
		guard auth.session != nil else {
			reset()
			return
		}
		if workspaces.isEmpty { phase = .loading }
		generation += 1
		let mine = generation
		let actor = auth.session?.actorId
		do {
			let list = try await source.listWorkspaces()
			// Signed out, or a different user signed in, or a newer refresh started meanwhile:
			// this list belongs to someone else's question. Never select from it.
			guard mine == generation, auth.session?.actorId == actor else { return }
			workspaces = list
			phase = .loaded
			if selected == nil, let first = list.first { auth.selectWorkspace(first.id) }
		} catch {
			guard mine == generation, auth.session?.actorId == actor else { return }
			let message = (error as? WorkspaceListingError)?.message ?? error.localizedDescription
			phase = .failed(message)
		}
	}

	public func select(_ id: String) {
		guard workspaces.contains(where: { $0.id == id }) else { return }
		auth.selectWorkspace(id)
	}

	/// Forget everything (sign-out).
	public func reset() {
		generation += 1
		workspaces = []
		phase = .idle
	}
}
