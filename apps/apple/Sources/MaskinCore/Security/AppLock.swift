import Foundation
import Observation

/// What the device can do for the lock right now.
public enum AppLockAvailability: Equatable, Sendable {
	/// Face ID, Touch ID or Optic ID (with the device passcode as fallback).
	case biometric(name: String)
	/// No biometrics enrolled, but a device passcode is set.
	case passcodeOnly
	/// No passcode (or no support on this platform): the lock cannot protect anything.
	case unavailable
}

public enum AppLockResult: Equatable, Sendable {
	case success
	/// The person dismissed the prompt or failed it; stay locked and let them retry.
	case failed
	/// The device cannot authenticate at all (passcode removed). Staying locked would strand the
	/// person with no way in.
	case unavailable
}

/// The platform's authentication, behind a protocol so the lock logic tests without biometrics.
public protocol AppLockAuthenticating: Sendable {
	var availability: AppLockAvailability { get }
	func authenticate(reason: String) async -> AppLockResult
}

/// Whether the person turned the lock on. Per device, so UserDefaults, not the Keychain: it is a
/// preference, not a secret.
public protocol AppLockStoring: Sendable {
	func loadEnabled() -> Bool
	func saveEnabled(_ enabled: Bool)
}

public struct UserDefaultsAppLockStorage: AppLockStoring, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key = "app-lock.enabled"

	public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

	public func loadEnabled() -> Bool { defaults.bool(forKey: key) }
	public func saveEnabled(_ enabled: Bool) { defaults.set(enabled, forKey: key) }
}

public final class InMemoryAppLockStorage: AppLockStoring, @unchecked Sendable {
	private var enabled: Bool
	public init(enabled: Bool = false) { self.enabled = enabled }
	public func loadEnabled() -> Bool { enabled }
	public func saveEnabled(_ enabled: Bool) { self.enabled = enabled }
}

/// Opt-in app lock: Face ID / Touch ID / passcode. Off by default. When on, the app locks at cold
/// launch and when it has been in the background for longer than `gracePeriod`.
@MainActor @Observable
public final class AppLockController {
	/// How long the app may sit in the background before it asks again.
	public static let gracePeriod: TimeInterval = 30

	public private(set) var isEnabled: Bool
	public private(set) var isLocked: Bool
	/// True while the system prompt is up.
	public private(set) var isAuthenticating = false
	/// Set after a failed or cancelled attempt; cleared on the next one.
	public private(set) var lastAttemptFailed = false
	/// The scene is not the active one (app switcher, background). The view hides content then so
	/// the system snapshot never shows it.
	public private(set) var isInactive = false

	@ObservationIgnored private let storage: any AppLockStoring
	@ObservationIgnored private let authenticator: any AppLockAuthenticating
	@ObservationIgnored private let now: () -> Date
	@ObservationIgnored private var backgroundedAt: Date?

	public init(
		storage: any AppLockStoring = UserDefaultsAppLockStorage(),
		authenticator: any AppLockAuthenticating,
		now: @escaping () -> Date = Date.init
	) {
		self.storage = storage
		self.authenticator = authenticator
		self.now = now
		let enabled = storage.loadEnabled()
		isEnabled = enabled
		// Cold launch: locked whenever the lock is on.
		isLocked = enabled
	}

	public var availability: AppLockAvailability { authenticator.availability }

	/// Content must be covered: locked, or about to be snapshotted by the system.
	public var shouldCoverContent: Bool { isEnabled && hasSession && (isLocked || isInactive) }

	/// Nothing to protect on the sign-in screen, so the lock stays out of its way.
	public private(set) var hasSession = true

	/// Turning it on proves the person can pass the prompt first, so they cannot lock themselves
	/// out. Turning it off needs no prompt (they are already past the lock). Returns the new state.
	@discardableResult
	public func setEnabled(_ on: Bool) async -> Bool {
		guard on != isEnabled else { return isEnabled }
		if on {
			guard authenticator.availability != .unavailable else { return false }
			guard !isAuthenticating else { return false }
			isAuthenticating = true
			let result = await authenticator.authenticate(reason: "Turn on app lock")
			isAuthenticating = false
			guard result == .success else { return false }
			isEnabled = true
			isLocked = false
		} else {
			isEnabled = false
			isLocked = false
		}
		storage.saveEnabled(isEnabled)
		return isEnabled
	}

	public enum ScenePhase: Sendable { case active, inactive, background }

	public func scenePhaseChanged(_ phase: ScenePhase) {
		switch phase {
		case .active:
			isInactive = false
			if isEnabled, !isLocked, let at = backgroundedAt, now().timeIntervalSince(at) >= Self.gracePeriod {
				isLocked = true
			}
			backgroundedAt = nil
		case .inactive:
			isInactive = true
		case .background:
			isInactive = true
			if backgroundedAt == nil { backgroundedAt = now() }
		}
	}

	/// Called with the auth state. A fresh sign-in is not a return to the app: do not prompt
	/// straight after typing a password. A session restored at launch never passes through `false`.
	public func sessionChanged(hasSession: Bool) {
		if hasSession, !self.hasSession { isLocked = false }
		self.hasSession = hasSession
	}

	public func unlock() async {
		guard isEnabled, isLocked, !isAuthenticating else { return }
		isAuthenticating = true
		lastAttemptFailed = false
		let result = await authenticator.authenticate(reason: "Unlock Maskin")
		isAuthenticating = false
		switch result {
		case .success:
			isLocked = false
		case .failed:
			lastAttemptFailed = true
		case .unavailable:
			// The passcode was removed: the lock protects nothing and would strand the person.
			isEnabled = false
			isLocked = false
			storage.saveEnabled(false)
		}
	}
}
