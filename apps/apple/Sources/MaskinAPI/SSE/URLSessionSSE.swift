import Foundation

extension SSEClient {
	/// The production opener: `GET /api/events` with the caller's credentials. Pass
	/// `credentials` as a provider so a workspace switch is picked up on the next reconnect.
	public static func events(
		baseURL: URL,
		clientSource: String,
		credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .maskinStreaming
	) -> SSEClient {
		SSEClient { lastEventID in
			var request = URLRequest(url: baseURL.appendingPathComponent("api/events"))
			request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
			request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
			request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
			if let creds = await credentials() {
				request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
				if let workspaceId = creds.workspaceId {
					request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
				}
			}
			if let lastEventID { request.setValue(lastEventID, forHTTPHeaderField: "Last-Event-ID") }

			let (bytes, response) = try await session.bytes(for: request)
			if let http = response as? HTTPURLResponse, http.statusCode != 200 {
				throw SSEError.badStatus(http.statusCode)
			}
			return AsyncThrowingStream { continuation in
				let task = Task {
					do {
						for try await byte in bytes { continuation.yield(byte) }
						continuation.finish()
					} catch {
						continuation.finish(throwing: error)
					}
				}
				continuation.onTermination = { _ in task.cancel() }
			}
		}
	}
}

extension URLSession {
	/// No resource timeout: an event stream is meant to stay open for hours.
	public static let maskinStreaming: URLSession = {
		let config = URLSessionConfiguration.ephemeral
		config.timeoutIntervalForRequest = 60
		config.timeoutIntervalForResource = .infinity
		config.waitsForConnectivity = true
		return URLSession(configuration: config)
	}()
}
