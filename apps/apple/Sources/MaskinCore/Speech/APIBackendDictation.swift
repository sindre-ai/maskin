import Foundation
import MaskinAPI

/// The server refused or could not finish a transcription (any answer other than 200).
public struct BackendDictationError: Error, Equatable, Sendable {
	public init() {}
}

/// `POST /api/transcriptions` on the generated client. The generated operation names stop here; the
/// rest of the app sees `SpeechTranscribing`.
public struct APIBackendDictation: SpeechTranscribing {
	private let client: Client

	public init(client: Client) {
		self.client = client
	}

	public func transcribe(wav: Data, language: String?) async throws -> String {
		let body = Components.Schemas.TranscribeBody(audio: wav.base64EncodedString(), language: language)
		let output = try await client.post_sol_api_sol_transcriptions(
			Operations.post_sol_api_sol_transcriptions.Input(body: .json(body)))
		guard case .ok(let ok) = output else { throw BackendDictationError() }
		return try ok.body.json.text
	}
}
