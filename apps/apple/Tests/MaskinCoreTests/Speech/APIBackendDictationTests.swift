import Foundation
import HTTPTypes
import MaskinAPI
import OpenAPIRuntime
import Testing

@testable import MaskinAPI
@testable import MaskinCore

private final class BodyTransport: ClientTransport, @unchecked Sendable {
	private let lock = NSLock()
	private var _bodies: [String] = []
	var bodies: [String] { lock.withLock { _bodies } }

	func send(
		_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String
	) async throws -> (HTTPResponse, HTTPBody?) {
		var text = ""
		if let body { text = String(decoding: try await Data(collecting: body, upTo: 1 << 20), as: UTF8.self) }
		lock.withLock { _bodies.append(text) }
		var response = HTTPResponse(status: .ok)
		response.headerFields[.contentType] = "application/json"
		return (response, HTTPBody(#"{"text":"hej"}"#))
	}
}

@Suite("Dictation request")
struct APIBackendDictationTests {
	// A language hint made the model spell an English invoice number as words, and no hint did as
	// well or better on every recording, so the request carries the audio and nothing else.
	@Test("sends the audio and no language hint")
	func sendsNoLanguageHint() async throws {
		let transport = BodyTransport()
		let client = Client(serverURL: URL(string: "http://localhost:3000")!, transport: transport)
		let text = try await APIBackendDictation(client: client).transcribe(wav: Data([1, 2, 3]))
		#expect(text == "hej")
		let body = try #require(transport.bodies.first)
		#expect(body.contains(#""audio""#))
		#expect(!body.contains("language"))
	}
}
