import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

public struct WorkspaceSummary: Identifiable, Sendable, Equatable, Codable {
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
	/// How current the list on screen is (cache-hydrated until the first fetch succeeds).
	public private(set) var freshness = Freshness()

	@ObservationIgnored private let source: any WorkspaceListing
	@ObservationIgnored private let auth: AuthSession
	/// Bumped on `reset()` and every `refresh()`; only the latest load for the same actor may write.
	@ObservationIgnored private var generation = 0

	@ObservationIgnored private let disk: DiskCache?
	static let cacheName = "workspaces.list"

	/// - Parameter disk: when given, the list is remembered per signed-in actor so the switcher and
	///   the selected workspace's name are there on the first frame. Per actor, never per
	///   workspace: it is the list OF workspaces.
	public init(source: any WorkspaceListing, auth: AuthSession, disk: DiskCache? = nil) {
		self.source = source
		self.auth = auth
		self.disk = disk
		hydrateIfNeeded()
	}

	private var cacheKey: DiskCache.Key? {
		auth.session.map { DiskCache.Key(actorId: $0.actorId, name: Self.cacheName) }
	}

	/// Fill from disk for the current actor. Called at init and again from `refresh()` because
	/// the session is usually restored after the store is built.
	private func hydrateIfNeeded() {
		guard phase == .idle, workspaces.isEmpty, let disk, let key = cacheKey,
			let entry = disk.read([WorkspaceSummary].self, key: key, version: 1)
		else { return }
		workspaces = entry.value
		phase = .loaded
		freshness.hydrated(from: entry.savedAt)
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
		hydrateIfNeeded()
		if workspaces.isEmpty { phase = .loading }
		generation += 1
		let mine = generation
		let actor = auth.session?.actorId
		let started = ContinuousClock.now
		do {
			let list = try await source.listWorkspaces()
			// Signed out, or a different user signed in, or a newer refresh started meanwhile:
			// this list belongs to someone else's question. Never select from it.
			guard mine == generation, auth.session?.actorId == actor else { return }
			workspaces = list
			phase = .loaded
			freshness.refreshed(at: Date())
			SyncLog.revalidated(Self.cacheName, ok: true, since: started)
			if let disk, let key = cacheKey { disk.write(list, key: key, version: 1) }
			if selected == nil, let first = list.first { auth.selectWorkspace(first.id) }
		} catch {
			guard mine == generation, auth.session?.actorId == actor else { return }
			let message = (error as? WorkspaceListingError)?.message ?? error.localizedDescription
			freshness.revalidateFailed()
			SyncLog.revalidated(Self.cacheName, ok: false, since: started)
			// A failed revalidate never blanks a list that is already on screen.
			if workspaces.isEmpty { phase = .failed(message) }
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
		freshness.reset()
	}
}
