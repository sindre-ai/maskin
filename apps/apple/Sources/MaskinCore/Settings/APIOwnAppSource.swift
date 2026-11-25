import Foundation
import MaskinAPI

/// Production `OwnAppAPI`. Reading and removing the app use the generated client (`APISettingsSource`).
/// Saving has no request body in the API description (the server reads and zeroes the raw bytes, as
/// for the Keychain routes), so that one is built by hand; nothing here logs or keeps the secret.
public struct APIOwnAppSource: OwnAppAPI {
	private let settings: APISettingsSource
	private let workspaceID: String
	private let baseURL: URL
	private let clientSource: String
	private let credentialsProvider: MaskinCredentialsProvider
	private let session: URLSession

	public init(
		client: Client, workspaceID: String, baseURL: URL, clientSource: String,
		credentials: @escaping MaskinCredentialsProvider, session: URLSession = .shared
	) {
		self.settings = APISettingsSource(client: client, workspaceID: workspaceID)
		self.workspaceID = workspaceID
		self.baseURL = baseURL
		self.clientSource = clientSource
		self.credentialsProvider = credentials
		self.session = session
	}

	public func status(provider: String) async throws -> OwnAppStatus {
		try await settings.status(provider: provider)
	}

	public func remove(provider: String, idempotencyKey: String) async throws {
		try await settings.remove(provider: provider, idempotencyKey: idempotencyKey)
	}

	/// The request for saving the app. The server's body schema is strict: exactly these two fields.
	static func saveRequest(
		baseURL: URL, provider: String, clientId: String, clientSecret: String
	) throws -> URLRequest {
		var request = URLRequest(
			url: baseURL.appendingPathComponent("api/integrations/\(provider)/app"))
		request.httpMethod = "PUT"
		request.timeoutInterval = 30
		request.setValue("application/json", forHTTPHeaderField: "Accept")
		request.setValue("application/json", forHTTPHeaderField: "Content-Type")
		request.httpBody = try JSONSerialization.data(withJSONObject: [
			"clientId": clientId, "clientSecret": clientSecret,
		])
		return request
	}

	/// The server's sentence for each refusal, as the generated-client path gave it. These routes
	/// name fields and never echo a value, so the server's own message is safe to show.
	static func failure(status: Int, body: Data) -> SettingsError {
		struct Envelope: Decodable {
			struct Detail: Decodable { var message: String? }
			var error: Detail?
		}
		let message = (try? JSONDecoder().decode(Envelope.self, from: body))?.error?.message
		switch status {
		case 400:
			return SettingsError(
				APISettingsSource.sentence(message, fallback: "Check the app id and secret and try again."))
		case 403: return SettingsError("Only a workspace admin or owner can change the sign-in app.")
		case 404: return SettingsError("This tool does not take its own sign-in app.")
		case 409:
			return SettingsError(
				APISettingsSource.sentence(
					message, fallback: "Disconnect the tool first: a different app id would strand it."))
		default: return SettingsError("Couldn't save the app.")
		}
	}

	public func save(provider: String, clientId: String, clientSecret: String, idempotencyKey: String)
		async throws -> OwnAppStatus
	{
		var request = try Self.saveRequest(
			baseURL: baseURL, provider: provider, clientId: clientId, clientSecret: clientSecret)
		request.setValue(clientSource, forHTTPHeaderField: "X-Client-Source")
		request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
		if let creds = await credentialsProvider() {
			request.setValue("Bearer \(creds.apiKey)", forHTTPHeaderField: "Authorization")
			request.setValue(creds.workspaceId ?? workspaceID, forHTTPHeaderField: "X-Workspace-Id")
		} else {
			request.setValue(workspaceID, forHTTPHeaderField: "X-Workspace-Id")
		}
		let data: Data
		let response: URLResponse
		do {
			(data, response) = try await session.data(for: request)
		} catch {
			throw APISettingsSource.map(error)
		}
		let status = (response as? HTTPURLResponse)?.statusCode ?? 0
		guard (200..<300).contains(status) else { throw Self.failure(status: status, body: data) }
		struct Saved: Decodable {
			var configured: Bool
			var clientId: String?
			var callbackUrl: String
		}
		guard let saved = try? JSONDecoder().decode(Saved.self, from: data) else {
			throw SettingsError("Couldn't save the app.")
		}
		return OwnAppStatus(configured: saved.configured, clientId: saved.clientId, callbackURL: saved.callbackUrl)
	}
}
