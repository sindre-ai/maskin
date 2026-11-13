import Foundation
import MaskinAPI

/// Runs one declared query of a custom view as the signed-in viewer.
public protocol LoopDataQuerying: Sendable {
	/// `GET /api/data/query`: grouped counts, sums or averages. Returns the answer as the server
	/// sent it; the page decides how to draw it.
	func run(_ spec: JSONValue) async throws -> JSONValue
}

/// Production `LoopDataQuerying`. Hand-rolled over `URLSession` because the generated client does
/// not carry the data routes; the credentials stay here and never go near the page.
public struct URLSessionLoopDataQuery: LoopDataQuerying {
	private let baseURL: URL
	private let clientSource: String
	private let credentials: MaskinCredentialsProvider
	private let session: URLSession

	/// A query with no answer by now has hung. Same limit as the web view.
	static let timeout: TimeInterval = 30
	static let maxBodyBytes = 1_000_000

	public init(
		baseURL: URL, clientSource: String, credentials: @escaping MaskinCredentialsProvider,
		session: URLSession = .shared
	) {
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentials = credentials
		self.session = session
	}

	public func run(_ spec: JSONValue) async throws -> JSONValue {
		guard let creds = await credentials(), let workspace = creds.workspaceId else {
			throw LoopViewError("Sign in again to see this view.")
		}
		let request = try Self.request(
			for: spec, baseURL: baseURL, clientSource: clientSource, apiKey: creds.apiKey, workspace: workspace)
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch {
			throw LoopViewError("Couldn't reach the server. Check your connection.")
		}
		guard let http = response as? HTTPURLResponse else {
			throw LoopViewError("Couldn't load this number.")
		}
		guard (200..<300).contains(http.statusCode) else {
			throw LoopViewError(Self.message(status: http.statusCode, body: data))
		}
		guard data.count <= Self.maxBodyBytes,
			let answer = try? JSONDecoder().decode(JSONValue.self, from: data)
		else { throw LoopViewError("The server's answer could not be read.") }
		return answer
	}

	static func request(
		for spec: JSONValue, baseURL: URL, clientSource: String, apiKey: String, workspace: String
	) throws -> URLRequest {
		var components = URLComponents(
			url: baseURL.appendingPathComponent("api/data/query"), resolvingAgainstBaseURL: false)
		// Encoded by hand: URLComponents leaves "+" and "&" in a value as they are.
		let value = LoopViewBridge.canonical(spec).addingPercentEncoding(withAllowedCharacters: Self.unreserved)
		components?.percentEncodedQueryItems = [URLQueryItem(name: "spec", value: value)]
		guard let url = components?.url else { throw LoopViewError("This view asked for something that can't be sent.") }
		var request = URLRequest(url: url)
		request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
		request.setValue(workspace, forHTTPHeaderField: "X-Workspace-Id")
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.timeoutInterval = timeout
		return request
	}

	private static let unreserved: CharacterSet = {
		var set = CharacterSet.alphanumerics
		set.insert(charactersIn: "-._~")
		return set
	}()

	/// The server's own words for a refused query when it gave them, else a plain line per kind of failure.
	static func message(status: Int, body: Data) -> String {
		if status == 401 { return "Sign in again to see this view." }
		if status == 400 || status == 422 {
			if let text = (try? JSONDecoder().decode(JSONValue.self, from: body))?["error"]?.stringValue,
				!text.isEmpty, text.count <= 200
			{
				return text
			}
			return "The server did not accept this query."
		}
		if status == 429 || status >= 500 { return "The server may be busy. Try again." }
		return "Couldn't load this number."
	}
}
