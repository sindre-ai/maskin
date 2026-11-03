import Foundation
import Observation

/// The device asking to be signed in, as `GET /api/device-auth/preview` describes it.
public struct DeviceSignInPreview: Equatable, Sendable {
	/// `tvos` is the only client the server issues codes for today.
	public var client: String
	public var deviceName: String?
	public init(client: String, deviceName: String?) {
		self.client = client
		self.deviceName = deviceName
	}

	/// What the person is asked to approve, named for people ("Apple TV", not "tvos").
	public var deviceLabel: String {
		let kind = client == "tvos" ? "Apple TV" : "A device"
		guard let name = deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
		else { return kind }
		return "\(kind) · \(name)"
	}
}

public protocol DeviceSignInAPI: Sendable {
	func preview(code: String) async throws -> DeviceSignInPreview
	func approve(code: String, idempotencyKey: String) async throws
	func deny(code: String, idempotencyKey: String) async throws
}

/// The 8-character code a TV shows. Mirrors `normalizeUserCode` / `formatUserCode` on the server
/// (consonants and digits 2-9, so a code never spells a word or hides a 0/O).
public enum DeviceCode {
	public static let alphabet = Set("BCDFGHJKMNPQRSTVWXZ23456789")
	public static let length = 8

	/// "bcdf-2345" -> "BCDF2345", or nil when it cannot be a code.
	public static func normalize(_ raw: String) -> String? {
		let cleaned = raw.uppercased().filter { !$0.isWhitespace && $0 != "-" }
		guard cleaned.count == length, cleaned.allSatisfy(alphabet.contains) else { return nil }
		return cleaned
	}

	/// "BCDF2345" -> "BCDF-2345", the form shown on the device.
	public static func format(_ code: String) -> String {
		code.count > 4 ? "\(code.prefix(4))-\(code.dropFirst(4))" : code
	}

	/// Keeps typing tidy: only code characters, upper case, dash after four.
	public static func typed(_ raw: String) -> String {
		let kept = raw.uppercased().filter(alphabet.contains).prefix(length)
		return format(String(kept))
	}
}

/// Settings › Sign in a device: type the code, see which device asked, approve or refuse.
@MainActor
@Observable
public final class DeviceSignInStore {
	public enum Step: Equatable, Sendable {
		case enterCode
		case confirm(DeviceSignInPreview)
		case approved
		case refused
	}

	public private(set) var step: Step = .enterCode
	public private(set) var isBusy = false
	public private(set) var error: String?
	public private(set) var code = ""

	/// Bound to the text field; keeps only code characters.
	public func setCode(_ raw: String) { code = DeviceCode.typed(raw) }

	@ObservationIgnored private let api: any DeviceSignInAPI
	@ObservationIgnored private var activeCode: String?

	public init(api: any DeviceSignInAPI, initialCode: String? = nil) {
		self.api = api
		if let initialCode { setCode(initialCode) }
	}

	public var canContinue: Bool { DeviceCode.normalize(code) != nil && !isBusy }

	public func lookUp() async {
		guard let normalized = DeviceCode.normalize(code), !isBusy else { return }
		isBusy = true
		error = nil
		defer { isBusy = false }
		do {
			let preview = try await api.preview(code: normalized)
			activeCode = normalized
			step = .confirm(preview)
		} catch {
			self.error = Self.message(error)
		}
	}

	public func approve() async { await decide(approve: true) }
	public func refuse() async { await decide(approve: false) }

	private func decide(approve: Bool) async {
		guard let activeCode, !isBusy else { return }
		isBusy = true
		error = nil
		defer { isBusy = false }
		let key = UUID().uuidString
		do {
			if approve {
				try await api.approve(code: activeCode, idempotencyKey: key)
				step = .approved
			} else {
				try await api.deny(code: activeCode, idempotencyKey: key)
				step = .refused
			}
		} catch {
			self.error = Self.message(error)
		}
	}

	/// Back to an empty form (Done, or "Try another code").
	public func reset() {
		step = .enterCode
		code = ""
		error = nil
		activeCode = nil
	}

	private static func message(_ error: Error) -> String {
		(error as? SettingsError)?.message ?? "Couldn't reach Maskin. Try again."
	}
}

/// Production source over `SettingsHTTP`. A wrong code answers 404, which must not read as
/// "signed out".
public struct APIDeviceSignInSource: DeviceSignInAPI {
	private let http: SettingsHTTP

	public init(http: SettingsHTTP) { self.http = http }

	public func preview(code: String) async throws -> DeviceSignInPreview {
		let (data, status) = try await http.send(
			"GET", "api/device-auth/preview", query: [URLQueryItem(name: "user_code", value: code)])
		guard status == 200 else { throw Self.error(status) }
		struct Wire: Decodable {
			var client: String
			var device_name: String?
		}
		let wire = try SettingsHTTP.decode(Wire.self, data)
		return DeviceSignInPreview(client: wire.client, deviceName: wire.device_name)
	}

	public func approve(code: String, idempotencyKey: String) async throws {
		try await decide("api/device-auth/approve", code: code, key: idempotencyKey)
	}

	public func deny(code: String, idempotencyKey: String) async throws {
		try await decide("api/device-auth/deny", code: code, key: idempotencyKey)
	}

	private func decide(_ path: String, code: String, key: String) async throws {
		let body = try JSONEncoder().encode(["user_code": code])
		let (_, status) = try await http.send("POST", path, body: body, key: key)
		guard status == 200 else { throw Self.error(status) }
	}

	static func error(_ status: Int) -> SettingsError {
		switch status {
		case 403: SettingsError("Only a person can sign in a device, not an agent.")
		case 404: SettingsError("That code isn't valid or has expired. Check the screen on your device.")
		default: SettingsHTTP.error(status: status, data: Data(), fallback: "Couldn't reach Maskin. Try again.")
		}
	}
}
