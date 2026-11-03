import Foundation

/// What a store holds to cache its screen's data: a `DiskCache` plus "who is signed in" and "which
/// workspace is selected", read at call time so a workspace or account switch can never read or
/// write the wrong bucket.
///
/// Adopting it in a store takes three steps (see `Sync/README.md`): take `cache: SnapshotCache?`
/// in `init`, hydrate from it before the first network call, write to it after every successful
/// fetch. Passing `nil` (previews, most tests) turns caching off with no other behaviour change.
@MainActor
public struct SnapshotCache {
	public enum Scope: Sendable {
		/// Per (actor, workspace): lists inside a workspace.
		case workspace
		/// Per actor: things that span workspaces (the workspace list).
		case actor
	}

	public let disk: DiskCache
	private let actorId: @MainActor () -> String?
	private let workspaceId: @MainActor () -> String?
	public let now: @Sendable () -> Date

	public init(
		disk: DiskCache = .shared, actorId: @escaping @MainActor () -> String?,
		workspaceId: @escaping @MainActor () -> String?,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.disk = disk
		self.actorId = actorId
		self.workspaceId = workspaceId
		self.now = now
	}

	private func key(_ name: String, _ scope: Scope) -> DiskCache.Key? {
		guard let actor = actorId() else { return nil }
		switch scope {
		case .actor: return DiskCache.Key(actorId: actor, name: name)
		case .workspace:
			guard let ws = workspaceId() else { return nil }
			return DiskCache.Key(actorId: actor, workspaceId: ws, name: name)
		}
	}

	/// The cached value for the CURRENT actor and workspace, or nil.
	public func read<Value: Codable & Sendable>(
		_ type: Value.Type, _ name: String, version: Int = 1, scope: Scope = .workspace
	) -> DiskCache.Entry<Value>? {
		guard let key = key(name, scope) else { return nil }
		return disk.read(type, key: key, version: version)
	}

	public func write<Value: Codable & Sendable>(
		_ value: Value, _ name: String, version: Int = 1, scope: Scope = .workspace
	) {
		guard let key = key(name, scope) else { return }
		disk.write(value, key: key, version: version)
	}

	public func remove(_ name: String, scope: Scope = .workspace) {
		guard let key = key(name, scope) else { return }
		disk.remove(key)
	}
}

extension AppEnvironment {
	/// The cache stores should share: bound to the signed-in actor and selected workspace.
	public var snapshotCache: SnapshotCache {
		SnapshotCache(
			actorId: { [weak self] in self?.auth.session?.actorId },
			workspaceId: { [weak self] in self?.workspaceId })
	}
}
