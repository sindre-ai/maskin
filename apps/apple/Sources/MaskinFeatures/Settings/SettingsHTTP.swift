import Foundation
import MaskinAPI
import MaskinCore

/// A small hand-built JSON client for the Settings pages whose routes are not in the generated
/// client yet (extensions, device sign-in, pending invites, Claude subscription). Everything a
/// caller sees is a fixed sentence: no response body, id or key reaches a message.
struct SettingsHTTP: Sendable {
	let baseURL: URL
	let clientSource: String
	let credentials: MaskinCredentialsProvider
	var session: URLSession = .shared

	struct Reply: Sendable {
		var status: Int
		var data: Data
		var ok: Bool { (200..<300).contains(status) }
		var json: Any? { try? JSONSerialization.jsonObject(with: data) }
	}

	/// Sends one request. Throws only when the server could not be reached.
	func send(
		_ method: String, _ path: String, query: [URLQueryItem] = [], body: [String: Any]? = nil
	) async throws -> Reply {
		var parts = URLComponents(
			url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
		if !query.isEmpty { parts?.queryItems = query }
		guard let url = parts?.url else { throw SettingsError("Couldn't build the request.") }
		var request = URLRequest(url: url)
		request.httpMethod = method
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		if let creds = await credentials() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			if let workspaceId = creds.workspaceId {
				request.setValue(workspaceId, forHTTPHeaderField: "X-Workspace-Id")
			}
		}
		if method != "GET" {
			request.setValue(UUID().uuidString, forHTTPHeaderField: "Idempotency-Key")
		}
		if let body {
			request.setValue("application/json", forHTTPHeaderField: "Content-Type")
			request.httpBody = try JSONSerialization.data(withJSONObject: body)
		}
		do {
			let (data, response) = try await session.data(for: request)
			return Reply(status: (response as? HTTPURLResponse)?.statusCode ?? 0, data: data)
		} catch {
			throw SettingsError.offline
		}
	}

	static func date(_ value: Any?) -> Date? {
		guard let text = value as? String else { return nil }
		let f = ISO8601DateFormatter()
		f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
		if let d = f.date(from: text) { return d }
		f.formatOptions = [.withInternetDateTime]
		return f.date(from: text)
	}
}

extension SettingsServices {
	var http: SettingsHTTP {
		SettingsHTTP(
			baseURL: environment.baseURL, clientSource: environment.clientSource,
			credentials: environment.auth.credentialsProvider)
	}
}
