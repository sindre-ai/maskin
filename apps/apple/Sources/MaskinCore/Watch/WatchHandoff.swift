import Foundation

/// What the iPhone tells the paired watch about the sign-in: the session, or `nil` for "signed
/// out". Pure data and policy, so the rules are testable without a `WCSession`.
public struct WatchHandoff: Sendable, Equatable {
	public var session: StoredSession?

	public init(session: StoredSession?) { self.session = session }

	static let contextKey = "maskin.handoff.v1"

	/// The `WCSession` application-context dictionary. Property-list types only.
	public func context() -> [String: Any] {
		guard let session, let data = try? JSONEncoder().encode(session) else { return [:] }
		return [Self.contextKey: data]
	}

	/// An empty context (nothing ever published, or a sign-out) decodes to "signed out"; a payload
	/// this build can't decode is `nil`, so a newer phone build never signs the watch out.
	public init?(context: [String: Any]) {
		guard let data = context[Self.contextKey] as? Data else {
			self.init(session: nil)
			return
		}
		guard let stored = try? JSONDecoder().decode(StoredSession.self, from: data) else { return nil }
		self.init(session: stored)
	}
}

public enum WatchHandoffAction: Sendable, Equatable {
	case adopt(StoredSession)
	case signOut
	case ignore
}

/// Remembers which API key the watch took from the phone, so a phone-side sign-out only ends a
/// session the phone gave it — never one the wearer typed in on the watch themselves.
public protocol HandoffMarker: Sendable {
	var adoptedKey: String? { get }
	func setAdoptedKey(_ key: String?)
}

public struct UserDefaultsHandoffMarker: HandoffMarker, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String
	public init(defaults: UserDefaults = .standard, key: String = "watch.handoff.adoptedKey.v1") {
		self.defaults = defaults
		self.key = key
	}
	public var adoptedKey: String? { defaults.string(forKey: key) }
	public func setAdoptedKey(_ value: String?) { defaults.set(value, forKey: key) }
}

public final class InMemoryHandoffMarker: HandoffMarker, @unchecked Sendable {
	private let lock = NSLock()
	private var value: String?
	public init(adoptedKey: String? = nil) { value = adoptedKey }
	public var adoptedKey: String? { lock.withLock { value } }
	public func setAdoptedKey(_ key: String?) { lock.withLock { value = key } }
}

public enum WatchHandoffPolicy {
	/// - `current`: the session the watch holds now, if any.
	/// - `adoptedKey`: the key it last took from the phone.
	public static func decide(
		incoming: WatchHandoff, current: StoredSession?, adoptedKey: String?
	) -> WatchHandoffAction {
		switch (incoming.session, current) {
		case (let new?, nil):
			return .adopt(new)
		case (let new?, let current?):
			if new.apiKey == current.apiKey { return .ignore }
			// A rotated key for the same person, or a different person on a phone whose session we
			// were already mirroring: follow the phone. Keep the workspace the wearer picked.
			if new.actorId == current.actorId || current.apiKey == adoptedKey {
				var next = new
				if new.actorId == current.actorId { next.workspaceId = current.workspaceId ?? new.workspaceId }
				return .adopt(next)
			}
			return .ignore  // the wearer signed in on the watch themselves
		case (nil, let current?):
			return current.apiKey == adoptedKey ? .signOut : .ignore
		case (nil, nil):
			return .ignore
		}
	}
}
