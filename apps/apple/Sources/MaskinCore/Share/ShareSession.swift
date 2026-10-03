import Foundation
import MaskinAPI

/// What the extension needs to talk to the API, read from the Keychain session the app wrote.
public struct ShareCredentials: Sendable, Equatable {
	public var apiKey: String
	public var workspaceId: String
	public init(apiKey: String, workspaceId: String) {
		self.apiKey = apiKey
		self.workspaceId = workspaceId
	}
}

public enum ShareSession {
	/// Reads the shared session. Never writes or deletes: the extension must not be able to sign
	/// the user out of the app, even when the server rejects the key.
	public static func credentials(from store: any SecretStore) throws(ShareError) -> ShareCredentials {
		let data: Data?
		do { data = try store.read() } catch { throw .sessionUnreadable }
		guard let data else { throw .signedOut }
		guard let session = try? JSONDecoder().decode(StoredSession.self, from: data),
			!session.apiKey.isEmpty
		else { throw .signedOut }
		guard let workspaceId = session.workspaceId, !workspaceId.isEmpty else { throw .noWorkspace }
		return ShareCredentials(apiKey: session.apiKey, workspaceId: workspaceId)
	}

	/// The production remote for these credentials. No `onUnauthorized` hook: a 401 becomes
	/// `ShareError.sessionExpired` and the app, not the extension, decides what to do about it.
	/// Bounded waits: an extension has to be able to say "offline" in seconds, not minutes, and a
	/// hung upload must not pin the sheet. Uploads (up to ~14 MB of base64) get a longer resource cap.
	static func timeoutSession() -> URLSession {
		let configuration = URLSessionConfiguration.default
		configuration.timeoutIntervalForRequest = 20
		configuration.timeoutIntervalForResource = 120
		configuration.waitsForConnectivity = false
		return URLSession(configuration: configuration)
	}

	public static func remote(baseURL: URL, credentials: ShareCredentials) -> APIShareRemote {
		let client = MaskinClient.make(
			serverURL: baseURL, clientSource: "ios",
			credentials: { MaskinCredentials(apiKey: credentials.apiKey, workspaceId: credentials.workspaceId) },
			session: timeoutSession())
		return APIShareRemote(client: client, workspaceID: credentials.workspaceId)
	}
}
