import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `DeviceRegistering`. The server's device-token routes (`/api/devices`) are not in
/// the API this client is generated from yet, so registering has nothing to call and says so,
/// the same outcome as the server answering 404. Restore the generated `POST /api/devices`
/// (an upsert keyed on token + environment) and `DELETE /api/devices/{id}` calls once the
/// backend foundation (#1864) is in `main` and `openapi.json` is regenerated.
public struct APIDeviceRegistrar: DeviceRegistering {
	private let client: Client

	public init(client: Client) { self.client = client }

	public func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) async throws -> String {
		throw NotificationsError("Push notifications aren't available on this server yet.")
	}

	public func unregister(deviceId: String) async throws {}
}

/// What the push registration calls throw when the server or network refuses.
public struct NotificationsError: Error, Equatable, Sendable {
	public var message: String
	public init(_ message: String) { self.message = message }
}
