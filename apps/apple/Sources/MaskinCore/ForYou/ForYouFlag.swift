import Foundation
import MaskinAPI

/// Whether the v8 For you screen is on for the signed-in person: `GET /api/feature-flags`, the
/// flag registered in `apps/dev/src/lib/feature-flags.ts`. Off (or any failure) is the screen as it
/// was. The answer is reused for `flagLifetime` so a refresh does not wait on a request, and a
/// different signed-in key never reuses another person's answer.
public actor APIForYouV8Flag {
	public static let flagID = "apple-foryou-v8"

	private let client: Client
	private let credentials: MaskinCredentialsProvider
	private let flagLifetime: TimeInterval
	private var cachedFlag: (apiKey: String, enabled: Bool, at: Date)?

	public init(client: Client, credentials: @escaping MaskinCredentialsProvider, flagLifetime: TimeInterval = 300) {
		self.client = client
		self.credentials = credentials
		self.flagLifetime = flagLifetime
	}

	public func isEnabled() async -> Bool {
		guard let apiKey = await credentials()?.apiKey else { return false }
		if let cachedFlag, cachedFlag.apiKey == apiKey, Date().timeIntervalSince(cachedFlag.at) < flagLifetime {
			return cachedFlag.enabled
		}
		do {
			let output = try await client.get_sol_api_sol_feature_hyphen_flags(
				Operations.get_sol_api_sol_feature_hyphen_flags.Input())
			guard case .ok(let ok) = output else { return false }
			let enabled = try ok.body.json.flags.additionalProperties[Self.flagID] ?? false
			cachedFlag = (apiKey, enabled, Date())
			return enabled
		} catch {
			return false
		}
	}
}
