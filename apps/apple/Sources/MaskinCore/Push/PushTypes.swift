import Foundation

/// Which APNs gateway a device token belongs to. A sandbox token sent to production (or the
/// reverse) is rejected by Apple, so the backend stores and targets them separately.
public enum PushEnvironment: String, Sendable, Equatable {
	case sandbox
	case production

	/// Reads the `aps-environment` entitlement out of a provisioning profile's raw bytes (the
	/// profile is a CMS blob wrapping an XML plist, so the plist text is findable verbatim).
	/// `nil` when the entitlement isn't there.
	public static func parse(provisioningProfile data: Data) -> PushEnvironment? {
		let text = String(decoding: data, as: UTF8.self)
		guard let key = text.range(of: "<key>aps-environment</key>") else { return nil }
		let tail = text[key.upperBound...].prefix(120)
		if tail.contains("<string>production</string>") { return .production }
		if tail.contains("<string>development</string>") { return .sandbox }
		return nil
	}

	/// Best available answer for the running binary: the embedded provisioning profile when there
	/// is one (development- and ad-hoc-signed builds), otherwise production, because App Store and
	/// TestFlight builds carry no profile and always use the production gateway. Simulators
	/// and DEBUG builds without a profile use sandbox.
	public static func detect(bundle: Bundle = .main) -> PushEnvironment {
		let candidates = [
			bundle.url(forResource: "embedded", withExtension: "mobileprovision"),
			bundle.bundleURL.appendingPathComponent("Contents/embedded.provisionprofile"),
		]
		for case let url? in candidates {
			if let data = try? Data(contentsOf: url), let env = parse(provisioningProfile: data) {
				return env
			}
		}
		#if targetEnvironment(simulator) || DEBUG
			return .sandbox
		#else
			return .production
		#endif
	}
}

public enum PushPermission: Sendable, Equatable {
	case notDetermined
	case denied
	case authorized
}

public enum DevicePlatform: String, Sendable, Equatable {
	case ios, macos, watchos, tvos
}

/// `POST /api/devices` and `DELETE /api/devices/{id}`. A protocol so the registrar tests without
/// a server. Registration returns the server's device id; unregistering uses that id, never the
/// raw APNs token, so the token stays out of URLs (and the logs that record them).
public protocol DeviceRegistering: Sendable {
	func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) async throws -> String
	func unregister(deviceId: String) async throws
}

/// An unregister that didn't get through (offline at sign-out). Persisted so it isn't forgotten.
public struct PendingUnregister: Codable, Sendable, Equatable {
	public var deviceId: String
	public var token: String
	public var actorId: String
	public init(deviceId: String, token: String, actorId: String) {
		self.deviceId = deviceId
		self.token = token
		self.actorId = actorId
	}
}

public protocol PendingUnregisterStore: Sendable {
	func load() -> PendingUnregister?
	func save(_ pending: PendingUnregister?)
}

public final class InMemoryPendingUnregisterStore: PendingUnregisterStore, @unchecked Sendable {
	private let lock = NSLock()
	private var value: PendingUnregister?
	public init(_ value: PendingUnregister? = nil) { self.value = value }
	public func load() -> PendingUnregister? { lock.withLock { value } }
	public func save(_ pending: PendingUnregister?) { lock.withLock { value = pending } }
}

public struct UserDefaultsPendingUnregisterStore: PendingUnregisterStore, @unchecked Sendable {
	private let defaults: UserDefaults
	private let key: String
	public init(defaults: UserDefaults = .standard, key: String = "push.pendingUnregister.v1") {
		self.defaults = defaults
		self.key = key
	}
	public func load() -> PendingUnregister? {
		defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(PendingUnregister.self, from: $0) }
	}
	public func save(_ pending: PendingUnregister?) {
		if let pending, let data = try? JSONEncoder().encode(pending) {
			defaults.set(data, forKey: key)
		} else {
			defaults.removeObject(forKey: key)
		}
	}
}

/// The OS side of push, supplied by the app target (UserNotifications / UIKit / AppKit), so
/// `MaskinCore` stays free of platform frameworks.
public protocol PushSystem: Sendable {
	func currentPermission() async -> PushPermission
	/// Shows the system permission prompt. `true` if granted.
	func requestPermission() async -> Bool
	/// Asks the OS for a device token; it arrives later via `PushRegistrar.didReceive(deviceToken:)`.
	@MainActor func registerForRemoteNotifications()
	/// Badge count on the app icon.
	@MainActor func setBadge(_ count: Int)
}

extension Data {
	/// Lowercase hex, the form the backend and APNs expect.
	var pushTokenHex: String { map { String(format: "%02x", $0) }.joined() }
}
