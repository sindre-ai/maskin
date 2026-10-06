import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `DeviceRegistering`: `POST /api/devices` (an upsert keyed on token + environment,
/// so it is safe to repeat) and `DELETE /api/devices/{id}`. The generated client sits behind
/// this adapter; operation names stay in this file.
public struct APIDeviceRegistrar: DeviceRegistering {
	private let client: Client

	public init(client: Client) { self.client = client }

	public func register(
		token: String, environment: PushEnvironment, platform: DevicePlatform, appVersion: String?
	) async throws -> String {
		let body = Operations.post_sol_api_sol_devices.Input.Body.jsonPayload(
			platform: .init(rawValue: platform.rawValue) ?? .ios, apns_token: token,
			environment: environment == .sandbox ? .sandbox : .production, app_version: appVersion)
		let output = try await IdempotencyKey.$current.withValue(IdempotencyKey.make()) {
			try await client.post_sol_api_sol_devices(.init(body: .json(body)))
		}
		guard case .ok(let ok) = output else {
			throw NotificationsError("Couldn't register this device for push.")
		}
		return try ok.body.json.id
	}

	public func unregister(deviceId: String) async throws {
		let output = try await client.delete_sol_api_sol_devices_sol__lcub_id_or_token_rcub_(
			path: .init(id_or_token: deviceId))
		switch output {
		case .ok, .notFound: return  // already gone is the goal state
		default: throw NotificationsError("Couldn't unregister this device.")
		}
	}
}
