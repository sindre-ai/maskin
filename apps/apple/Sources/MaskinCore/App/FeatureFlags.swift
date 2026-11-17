import Foundation
import MaskinAPI
import Observation
import OpenAPIRuntime

/// Flag ids the app reads. Same ids as `FLAGS` in `apps/dev/src/lib/feature-flags.ts`.
public enum FeatureFlagID {
	/// Undo send in chat: a sent message is held for a few seconds behind an Undo bar.
	public static let chatUndoSend = "chat-undo-send"
}

/// Network seam for the resolved flags (`GET /api/feature-flags`).
public protocol FeatureFlagsAPI: Sendable {
	func flags() async throws -> [String: Bool]
}

/// Production source. The generated client's operation name stays inside this file.
public struct APIFeatureFlagsSource: FeatureFlagsAPI {
	private let client: Client

	public init(client: Client) { self.client = client }

	public func flags() async throws -> [String: Bool] {
		switch try await client.get_sol_api_sol_feature_hyphen_flags() {
		case .ok(let ok): return try ok.body.json.flags.additionalProperties
		default: throw FeatureFlagsError.unavailable
		}
	}
}

public enum FeatureFlagsError: Error, Equatable, Sendable {
	case unavailable
}

/// The flags resolved for the signed-in actor. Everything is off until a load succeeds, and a
/// failed load keeps what was last known, so a flaky network never switches a feature on.
@MainActor
@Observable
public final class FeatureFlagStore {
	public private(set) var flags: [String: Bool] = [:]
	@ObservationIgnored private let api: any FeatureFlagsAPI

	public init(api: any FeatureFlagsAPI) { self.api = api }

	public func isEnabled(_ id: String) -> Bool { flags[id] ?? false }

	public func load() async {
		guard let resolved = try? await api.flags() else { return }
		flags = resolved
	}

	/// Signed out or on another account: nothing stays on.
	public func reset() { flags = [:] }
}
