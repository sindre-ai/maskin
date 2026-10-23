import Foundation
import MaskinAPI

/// Production `DeviceRegistering`: `POST /api/devices` (an upsert keyed on APNs token + environment
/// that answers with the device and its id) and `DELETE /api/devices/{id}`. Hand-encoded
/// `URLSession` requests, like `APINotificationPreferencesSource`, because the checked-in generated
/// client predates these routes. The routes are per actor, so no `X-Workspace-Id`. The raw token is
/// only ever in the POST body, never in a URL. Error text is fixed: no bodies, ids or keys are
/// interpolated.
public struct APIDeviceRegistrar: DeviceRegistering {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) async throws -> String {
		var request = await makeRegisterRequest(
			idempotencyKey: UUID().uuidString)
		request.httpBody = try Self.registerBody(
			token: token, environment: environment, platform: platform, appVersion: appVersion)
		let data = try await send(request)
		guard let device = try? JSONDecoder().decode(Device.self, from: data), !device.id.isEmpty else {
			throw NotificationsError("Maskin sent a reply this version can't read.")
		}
		return device.id
	}

	public func unregister(deviceId: String) async throws {
		// The server answers 404 for a device that is already gone: that is the goal reached.
		_ = try await send(await makeUnregisterRequest(deviceId: deviceId), acceptingNotFound: true)
	}

	/// Built apart from sending so tests can read the URL, headers and body.
	func makeRegisterRequest(idempotencyKey: String) async -> URLRequest {
		var request = await baseRequest(path: "api/devices", method: "POST")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
		return request
	}

	func makeUnregisterRequest(deviceId: String) async -> URLRequest {
		await baseRequest(path: "api/devices/\(deviceId)", method: "DELETE")
	}

	static func registerBody(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) throws -> Data {
		try JSONEncoder().encode(
			RegisterBody(
				platform: platform.rawValue, apns_token: token, environment: environment.rawValue,
				app_version: appVersion.flatMap { $0.isEmpty ? nil : String($0.prefix(64)) }))
	}

	private func baseRequest(path: String, method: String) async -> URLRequest {
		var request = URLRequest(url: baseURL.appendingPathComponent(path))
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
		}
		return request
	}

	private func send(_ request: URLRequest, acceptingNotFound: Bool = false) async throws -> Data {
		let data: Data
		let status: Int
		do {
			let (body, response) = try await session.data(for: request)
			data = body
			status = (response as? HTTPURLResponse)?.statusCode ?? 0
		} catch {
			throw NotificationsError("Couldn't reach Maskin. Check your connection and try again.")
		}
		switch status {
		case 200..<300: return data
		case 404 where acceptingNotFound: return data
		case 401, 403: throw NotificationsError("Maskin didn't accept this sign-in. Sign in again to turn on notifications.")
		case 400..<500: throw NotificationsError("Maskin couldn't register this device for notifications.")
		default: throw NotificationsError("Maskin had a problem registering this device. Try again later.")
		}
	}

	private struct RegisterBody: Encodable {
		var platform: String
		var apns_token: String
		var environment: String
		var app_version: String?
	}

	private struct Device: Decodable { var id: String }
}

/// What the push registration calls throw when the server or network refuses.
public struct NotificationsError: Error, Equatable, Sendable, LocalizedError {
	public var message: String
	public init(_ message: String) { self.message = message }
	/// So `PushRegistrar.registration == .failed(text)` carries this text, not the generic one.
	public var errorDescription: String? { message }
}
