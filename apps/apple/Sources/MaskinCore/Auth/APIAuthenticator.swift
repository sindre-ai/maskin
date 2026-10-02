import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `Authenticating`: the generated client, unauthenticated (login is a public route).
public struct APIAuthenticator: Authenticating {
	private let client: Client

	public init(serverURL: URL, clientSource: String) {
		client = MaskinClient.make(serverURL: serverURL, clientSource: clientSource) { nil }
	}

	public func login(email: String, password: String) async throws -> LoginResult {
		let output: Operations.post_sol_api_sol_auth_sol_login.Output
		do {
			output = try await client.post_sol_api_sol_auth_sol_login(
				.init(body: .json(.init(email: email, password: password))))
		} catch {
			throw AuthError.network(error.localizedDescription)
		}

		switch output {
		case .ok(let ok):
			let body = try ok.body.json
			return LoginResult(
				apiKey: body.api_key, actorId: body.id, name: body.name, email: body.email,
				workspaceId: body.workspace_id)
		case .unauthorized:
			throw AuthError.invalidCredentials
		case .undocumented(let status, _):
			throw AuthError.server(status: status)
		}
	}
}
