import Foundation

/// Which APNs gateway a device token belongs to. A sandbox token sent to production (or the
/// reverse) is rejected by Apple, so the backend stores and targets them separately.
public enum PushEnvironment: String, Sendable, Equatable, Codable {
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

/// `POST /api/devices`, `POST /api/devices/unregister` and `DELETE /api/devices/{id}`. A protocol
/// so the registrar tests without a server. The raw APNs token only ever travels in a request
/// body, never in a URL (and the logs that record them).
public protocol DeviceRegistering: Sendable {
	/// Registers (upserts) the token and hands the server the device's own `unregisterSecret`;
	/// answers with the server's device id.
	func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?,
		unregisterSecret: String
	) async throws -> String
	/// The owner's authenticated delete. Needs the Bearer key, so it only works while signed in.
	func unregister(deviceId: String) async throws
	/// Drops the registration with the device's own secret, no Authorization header, so it works
	/// after sign-out. Returns normally on any 200 (`deleted` true or false: either way the row is
	/// not there for this secret). Throws `DeviceUnregisterRouteMissing` when the server predates
	/// the route (404 or 405), which is NOT done.
	func unregister(token: String, environment: PushEnvironment, secret: String) async throws
}

/// The server has no `POST /api/devices/unregister` (an older deploy). The registration is still
/// there, so callers keep it pending and fall back to the authenticated delete when signed in.
public struct DeviceUnregisterRouteMissing: Error, Equatable, Sendable {
	public init() {}
}

/// What this device told the server: the APNs token, its gateway and the device's own unregister
/// secret, plus the server's device id once known. Persisted BEFORE the register request goes out,
/// so a sign-out, a relaunch or a request still in flight always knows what to remove. Also the
/// "unregister still to do" record: the secret, not the account, is the credential.
public struct DeviceRegistration: Codable, Sendable, Equatable {
	public var token: String
	public var environment: PushEnvironment
	public var secret: String
	public var deviceId: String?
	public init(token: String, environment: PushEnvironment, secret: String, deviceId: String? = nil) {
		self.token = token
		self.environment = environment
		self.secret = secret
		self.deviceId = deviceId
	}

	/// 32 random bytes, url-safe base64 without padding (43 characters; the server accepts 32 to
	/// 128 of `A-Za-z0-9_-`).
	public static func generateSecret() -> String {
		let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max) }
		return Data(bytes).base64EncodedString()
			.replacingOccurrences(of: "+", with: "-")
			.replacingOccurrences(of: "/", with: "_")
			.replacingOccurrences(of: "=", with: "")
	}
}

public protocol DeviceRegistrationStore: Sendable {
	func load() -> DeviceRegistration?
	func save(_ registration: DeviceRegistration?)
}

public final class InMemoryDeviceRegistrationStore: DeviceRegistrationStore, @unchecked Sendable {
	private let lock = NSLock()
	private var value: DeviceRegistration?
	public init(_ value: DeviceRegistration? = nil) { self.value = value }
	public func load() -> DeviceRegistration? { lock.withLock { value } }
	public func save(_ registration: DeviceRegistration?) { lock.withLock { value = registration } }
}

/// Keeps a `DeviceRegistration` as one Keychain item: it holds the device secret, so it stays out
/// of UserDefaults. `KeychainSecretStore` writes it this-device-only and available after first
/// unlock, so it never syncs to iCloud or a backup, and a relaunch or a push-woken launch can read it.
public struct KeychainDeviceRegistrationStore: DeviceRegistrationStore {
	private let secrets: any SecretStore
	public init(secrets: any SecretStore) { self.secrets = secrets }

	/// What was last sent to the server.
	public static func registration() -> KeychainDeviceRegistrationStore {
		KeychainDeviceRegistrationStore(secrets: KeychainSecretStore(account: "push.registration"))
	}

	/// The registration still to be removed from the server (sign-out could not finish it).
	public static func pendingUnregister() -> KeychainDeviceRegistrationStore {
		// Older builds kept this record in UserDefaults, without a secret. It cannot use the new
		// route, so it is dropped rather than migrated.
		UserDefaults.standard.removeObject(forKey: "push.pendingUnregister.v1")
		return KeychainDeviceRegistrationStore(secrets: KeychainSecretStore(account: "push.pendingUnregister"))
	}

	public func load() -> DeviceRegistration? {
		guard let data = try? secrets.read() else { return nil }
		return try? JSONDecoder().decode(DeviceRegistration.self, from: data)
	}

	public func save(_ registration: DeviceRegistration?) {
		if let registration, let data = try? JSONEncoder().encode(registration) {
			try? secrets.write(data)
		} else {
			try? secrets.delete()
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
