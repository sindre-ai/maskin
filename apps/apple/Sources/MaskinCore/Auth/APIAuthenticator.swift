import Foundation
import MaskinAPI
import OpenAPIRuntime

/// Production `Authenticating`: the generated client, unauthenticated (login is a public route).
public struct APIAuthenticator: Authenticating {
	private let client: Client

	public init(serverURL: URL, clientSource: String) {
		client = MaskinClient.make(serverURL: serverURL, clientSource: clientSource) { nil }
	}

	/// For tests: a client built over a fake transport.
	init(client: Client) { self.client = client }

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

	public func signUp(name: String, email: String, password: String, idempotencyKey: String)
		async throws -> SignUpResult
	{
		let output: Operations.post_sol_api_sol_actors.Output
		do {
			// Keys and passwords never reach a log line or an error: only statuses and the
			// server's own field messages are carried out of here.
			output = try await IdempotencyKey.$current.withValue(idempotencyKey) {
				try await client.post_sol_api_sol_actors(
					.init(
						body: .json(
							.init(
								_type: .human, name: name, email: email, password: password,
								auto_create_workspace: true))))
			}
		} catch {
			throw SignUpError.network(error.localizedDescription)
		}

		switch output {
		case .created(let created):
			let body = try created.body.json
			return SignUpResult(
				login: LoginResult(
					apiKey: body.api_key, actorId: body.id, name: body.name, email: body.email,
					workspaceId: body.workspace_id),
				workspaceProvisioningFailed: body.workspace_provisioning_failed ?? false)
		case .badRequest(let bad):
			let details = (try? bad.body.json.error.details) ?? []
			throw SignUpError.invalid(
				fields: SignUpError.fieldMessages(details.map { ($0.field, $0.message) }))
		case .conflict:
			throw SignUpError.emailTaken
		case .undocumented(let status, _):
			throw status == 429 ? SignUpError.rateLimited : SignUpError.server(status: status)
		default:
			throw SignUpError.server(status: 500)
		}
	}
}

extension SignUpError {
	/// Folds the server's `details` into one message per field (first wins), dropping blank ones.
	public static func fieldMessages(_ details: [(field: String, message: String)]) -> [String: String] {
		var out: [String: String] = [:]
		for (field, message) in details where out[field] == nil && !message.isEmpty {
			out[field] = message
		}
		return out
	}
}
