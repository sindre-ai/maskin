import Foundation
import MaskinAPI

/// Whether the v8 For you screen is on for the signed-in person: `GET /api/feature-flags`, the
/// flag registered in `apps/dev/src/lib/feature-flags.ts`. Off is the screen as it was. The answer
/// is reused for `flagLifetime` so a refresh does not wait on a request, and a different signed-in
/// key never reuses another person's answer.
///
/// The last real answer is also kept on the device, per person, so the first draw after a cold start
/// already knows it (`remembered`) instead of drawing the old screen and then swapping it. When a
/// request fails the remembered answer stands in (off when there is none); a failure never
/// overwrites it.
public actor APIForYouV8Flag {
	public static let flagID = "apple-foryou-v8"

	private let client: Client
	private let credentials: MaskinCredentialsProvider
	private let flagLifetime: TimeInterval
	private let actorId: String?
	private let defaults: UserDefaults
	private var cachedFlag: (apiKey: String, enabled: Bool, at: Date)?

	public init(
		client: Client, credentials: @escaping MaskinCredentialsProvider, flagLifetime: TimeInterval = 300,
		actorId: String? = nil, defaults: UserDefaults = .standard
	) {
		self.client = client
		self.credentials = credentials
		self.flagLifetime = flagLifetime
		self.actorId = actorId
		self.defaults = defaults
	}

	/// The key the last answer is kept under; one per person, so one person's answer is never
	/// another's.
	static func memoryKey(actorId: String) -> String { "forYou.v8Flag.\(actorId)" }

	/// The last answer the server gave this person on this device; off when there is none.
	public static func remembered(actorId: String?, defaults: UserDefaults = .standard) -> Bool {
		guard let actorId else { return false }
		return defaults.bool(forKey: memoryKey(actorId: actorId))
	}

	public func isEnabled() async -> Bool {
		guard let apiKey = await credentials()?.apiKey else { return false }
		if let cachedFlag, cachedFlag.apiKey == apiKey, Date().timeIntervalSince(cachedFlag.at) < flagLifetime {
			return cachedFlag.enabled
		}
		do {
			let output = try await client.get_sol_api_sol_feature_hyphen_flags(
				Operations.get_sol_api_sol_feature_hyphen_flags.Input())
			guard case .ok(let ok) = output else { return Self.remembered(actorId: actorId, defaults: defaults) }
			let enabled = try ok.body.json.flags.additionalProperties[Self.flagID] ?? false
			cachedFlag = (apiKey, enabled, Date())
			if let actorId { defaults.set(enabled, forKey: Self.memoryKey(actorId: actorId)) }
			return enabled
		} catch {
			return Self.remembered(actorId: actorId, defaults: defaults)
		}
	}
}
