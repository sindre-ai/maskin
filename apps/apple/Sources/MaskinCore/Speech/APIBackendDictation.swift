import Foundation
import MaskinAPI

/// The server refused or could not finish a transcription (any answer other than 200).
public struct BackendDictationError: Error, Equatable, Sendable {
	public init() {}
}

/// `POST /api/transcriptions` and `GET /api/feature-flags` on the generated client. The generated
/// operation names stop here; the rest of the app sees `BackendDictationService`.
public actor APIBackendDictation: BackendDictationService {
	/// The flag registered in `apps/dev/src/lib/feature-flags.ts`.
	public static let flagID = "ios-backend-dictation"

	private let client: Client
	private let credentials: MaskinCredentialsProvider
	private let flagLifetime: TimeInterval
	private var cachedFlag: (apiKey: String, enabled: Bool, at: Date)?

	/// `flagLifetime` is how long a flag answer is reused, so tapping the mic doesn't wait on a
	/// request every time. A different signed-in key never reuses another person's answer.
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

	public func transcribe(wav: Data, language: String?) async throws -> String {
		let body = Components.Schemas.TranscribeBody(audio: wav.base64EncodedString(), language: language)
		let output = try await client.post_sol_api_sol_transcriptions(
			Operations.post_sol_api_sol_transcriptions.Input(body: .json(body)))
		guard case .ok(let ok) = output else { throw BackendDictationError() }
		return try ok.body.json.text
	}
}
