import Foundation
import MaskinAPI

/// The feature flags the calling person has switched on (`GET /api/feature-flags`). A protocol so
/// the screen tests without a server.
public protocol FeatureFlagsSource: Sendable {
	func flags() async throws -> [String: Bool]
}

public enum ChatListFlag {
	/// The new chat list is behind this flag on web and iPhone, so testers see it on both at once.
	public static let id = "chat-list-v2"

	/// On only when the server says so: a failed read leaves the list as it was.
	public static func isOn(_ source: any FeatureFlagsSource) async -> Bool {
		(try? await source.flags())?[id] ?? false
	}
}

/// The last answer, kept so the list opens in the right layout while the flag is read again.
public enum ChatListFlagCache {
	private static let key = "maskin.chatListV2.lastKnown"
	public static var lastKnown: Bool {
		get { UserDefaults.standard.bool(forKey: key) }
		set { UserDefaults.standard.set(newValue, forKey: key) }
	}
}

/// Production flags source on the generated client.
public struct APIFeatureFlags: FeatureFlagsSource {
	private let client: Client
	public init(client: Client) { self.client = client }

	public func flags() async throws -> [String: Bool] {
		let output = try await client.get_sol_api_sol_feature_hyphen_flags(.init())
		guard case .ok(let ok) = output else { throw ChatsError("Couldn't read the feature flags.") }
		return try ok.body.json.flags.additionalProperties
	}
}
