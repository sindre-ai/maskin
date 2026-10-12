import Foundation

/// Remembers, per actor, that the first-use moment is owed (set by a sign-up) and when it has
/// been seen. A sign-in never sets it, so only the FIRST session of a brand-new account sees it.
public protocol FirstUseStore: Sendable {
	func markPending(actorId: String)
	func isPending(actorId: String) -> Bool
	func markSeen(actorId: String)
}

public final class InMemoryFirstUseStore: FirstUseStore, @unchecked Sendable {
	private let lock = NSLock()
	private var pending: Set<String> = []
	public init() {}
	public func markPending(actorId: String) { lock.withLock { _ = pending.insert(actorId) } }
	public func isPending(actorId: String) -> Bool { lock.withLock { pending.contains(actorId) } }
	public func markSeen(actorId: String) { lock.withLock { _ = pending.remove(actorId) } }
}

public struct UserDefaultsFirstUseStore: FirstUseStore, @unchecked Sendable {
	private let defaults: UserDefaults
	private let prefix: String
	public init(defaults: UserDefaults = .standard, prefix: String = "auth.firstUsePending.v1.") {
		self.defaults = defaults
		self.prefix = prefix
	}
	public func markPending(actorId: String) { defaults.set(true, forKey: prefix + actorId) }
	public func isPending(actorId: String) -> Bool { defaults.bool(forKey: prefix + actorId) }
	public func markSeen(actorId: String) { defaults.removeObject(forKey: prefix + actorId) }
}
