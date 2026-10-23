import Foundation

/// Remembers an invite token across sign-in and relaunch, so a link opened while signed out (or
/// before the app had launched) resumes after login. Only the raw token is kept, for at most
/// `maxAge`: an invite is also short-lived on the server, and a stale token must not nag forever.
public protocol PendingInviteStore: Sendable {
	func load() -> String?
	func save(_ token: String)
	func clear()
}

public final class InMemoryPendingInviteStore: PendingInviteStore, @unchecked Sendable {
	private let lock = NSLock()
	private var token: String?
	public init(token: String? = nil) { self.token = token }
	public func load() -> String? { lock.withLock { token } }
	public func save(_ token: String) { lock.withLock { self.token = token } }
	public func clear() { lock.withLock { token = nil } }
}

public struct UserDefaultsPendingInviteStore: PendingInviteStore, @unchecked Sendable {
	private struct Entry: Codable {
		var token: String
		var savedAt: Date
	}

	public static let maxAge: TimeInterval = 7 * 24 * 60 * 60

	private let defaults: UserDefaults
	private let key: String
	private let now: @Sendable () -> Date

	public init(
		defaults: UserDefaults = .standard, key: String = "invite.pending.v1",
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.defaults = defaults
		self.key = key
		self.now = now
	}

	public func load() -> String? {
		guard let data = defaults.data(forKey: key) else { return nil }
		guard let entry = try? JSONDecoder().decode(Entry.self, from: data),
			InviteLink(token: entry.token) != nil,
			now().timeIntervalSince(entry.savedAt) < Self.maxAge
		else {
			clear()
			return nil
		}
		return entry.token
	}

	public func save(_ token: String) {
		guard let data = try? JSONEncoder().encode(Entry(token: token, savedAt: now())) else { return }
		defaults.set(data, forKey: key)
	}

	public func clear() { defaults.removeObject(forKey: key) }
}
