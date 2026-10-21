import Foundation
import Observation

/// Where "Not now" is remembered.
public protocol NotificationPromptStorage: Sendable {
	/// Do not ask again before this moment.
	func snoozedUntil() -> Date?
	func snooze(until date: Date?)
}

public final class InMemoryNotificationPromptStorage: NotificationPromptStorage, @unchecked Sendable {
	private let lock = NSLock()
	private var value: Date?
	public init(snoozedUntil: Date? = nil) { value = snoozedUntil }
	public func snoozedUntil() -> Date? { lock.withLock { value } }
	public func snooze(until date: Date?) { lock.withLock { value = date } }
}

public struct UserDefaultsNotificationPromptStorage: NotificationPromptStorage, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String
	public init(defaults: UserDefaults = .standard, key: String = "push.prompt.snoozedUntil.v1") {
		self.defaults = defaults
		self.key = key
	}
	public func snoozedUntil() -> Date? {
		defaults.object(forKey: key) as? Date
	}
	public func snooze(until date: Date?) {
		if let date { defaults.set(date, forKey: key) } else { defaults.removeObject(forKey: key) }
	}
}

/// When the app may offer to turn notifications on. Pure decisions, no UI and no OS calls.
///
/// - Only while the system has not been asked (`.notDetermined`). Anyone already authorized or
///   denied is left exactly as they are: authorized devices keep registering silently, denied ones
///   can't be prompted again and are pointed to Settings from the Notifications page.
/// - Only after a moment of value (an agent's decision or reply is on screen), never cold.
/// - "Not now" holds the offer back for `snooze` (7 days).
public struct NotificationPromptPolicy: Sendable {
	public static let snooze: TimeInterval = 7 * 24 * 60 * 60

	private let storage: any NotificationPromptStorage

	public init(storage: any NotificationPromptStorage = UserDefaultsNotificationPromptStorage()) {
		self.storage = storage
	}

	public func shouldOffer(permission: PushPermission, now: Date = Date()) -> Bool {
		guard permission == .notDetermined else { return false }
		if let until = storage.snoozedUntil(), now < until { return false }
		return true
	}

	public func recordNotNow(now: Date = Date()) {
		storage.snooze(until: now.addingTimeInterval(Self.snooze))
	}

	/// The person said yes (or the system now knows the answer): forget any snooze.
	public func recordAccepted() { storage.snooze(until: nil) }
}

/// The OS side the prompt needs. `PushRegistrar` is the production one.
@MainActor
public protocol PushPermissionControlling: AnyObject {
	/// Re-reads the system's answer.
	func refreshPermission() async -> PushPermission
	/// Shows the system prompt (if still undecided) and registers for remote notifications.
	func requestAuthorization() async
}

extension PushRegistrar: PushPermissionControlling {}

/// Drives the in-app pre-prompt. A moment of value calls `valueMoment()`; if the policy agrees, the
/// shell shows its sheet (`isPresented`). Accepting is the only path that reaches the system prompt.
@MainActor
@Observable
public final class NotificationPromptCoordinator {
	public var isPresented = false

	@ObservationIgnored private let policy: NotificationPromptPolicy
	@ObservationIgnored private let push: any PushPermissionControlling
	@ObservationIgnored private let now: @Sendable () -> Date
	/// One offer per launch even if several moments of value arrive.
	@ObservationIgnored private var offered = false
	@ObservationIgnored private var checking = false

	public init(
		policy: NotificationPromptPolicy = NotificationPromptPolicy(), push: any PushPermissionControlling,
		now: @escaping @Sendable () -> Date = { Date() }
	) {
		self.policy = policy
		self.push = push
		self.now = now
	}

	/// An agent decision or reply has just been shown. `canPresent` lets the shell hold back while
	/// another sheet is open.
	public func valueMoment(canPresent: Bool = true) async {
		guard !offered, !checking, canPresent else { return }
		checking = true
		defer { checking = false }
		let permission = await push.refreshPermission()
		guard policy.shouldOffer(permission: permission, now: now()) else { return }
		offered = true
		isPresented = true
	}

	/// "Turn on notifications": the system prompt, now that the reason is clear.
	public func accept() async {
		isPresented = false
		policy.recordAccepted()
		await push.requestAuthorization()
	}

	/// "Not now", or the sheet was swiped away.
	public func notNow() {
		guard isPresented else { return }
		isPresented = false
		policy.recordNotNow(now: now())
	}
}
