import Foundation
import Observation

/// Mirrors `apps/web/src/lib/auth.ts`. v1 assumes one workspace per actor (matches
/// today's auto-provisioned "My Workspace" on signup) — no workspace switcher.
@MainActor
@Observable
final class AuthManager {
	static let shared = AuthManager()

	private(set) var apiKey: String?
	private(set) var actorId: String?
	private(set) var actorName: String?
	private(set) var workspaceId: String?

	var isAuthenticated: Bool { apiKey != nil && workspaceId != nil }

	private init() {
		apiKey = Keychain.get(KeychainKey.apiKey)
		actorId = Keychain.get(KeychainKey.actorId)
		actorName = Keychain.get(KeychainKey.actorName)
		workspaceId = Keychain.get(KeychainKey.workspaceId)
	}

	private struct LoginBody: Encodable { let email: String, password: String }
	private struct SignupBody: Encodable { let type: String, name: String, email: String, password: String }
	private struct WorkspaceListItem: Decodable { let id: String, name: String }

	func login(email: String, password: String) async throws {
		let result: ActorWithKey = try await APIClient.shared.request(
			"auth/login", method: .post, body: LoginBody(email: email, password: password)
		)
		try await finishAuth(result: result)
	}

	func signup(name: String, email: String, password: String) async throws {
		let result: ActorWithKey = try await APIClient.shared.request(
			"actors", method: .post, body: SignupBody(type: "human", name: name, email: email, password: password)
		)
		try await finishAuth(result: result)
	}

	private func finishAuth(result: ActorWithKey) async throws {
		apiKey = result.apiKey
		actorId = result.id
		actorName = result.name
		Keychain.set(result.apiKey, forKey: KeychainKey.apiKey)
		Keychain.set(result.id, forKey: KeychainKey.actorId)
		Keychain.set(result.name, forKey: KeychainKey.actorName)

		// Signup returns workspace_id directly; login doesn't (see plan Context) —
		// fall back to the actor's first workspace membership.
		if let workspaceId = result.workspaceId {
			self.workspaceId = workspaceId
			Keychain.set(workspaceId, forKey: KeychainKey.workspaceId)
		} else {
			let workspaces: [WorkspaceListItem] = try await APIClient.shared.request("workspaces")
			guard let first = workspaces.first else {
				throw APIError(status: 0, code: nil, message: "No workspace found for this account.", fieldErrors: [:])
			}
			self.workspaceId = first.id
			Keychain.set(first.id, forKey: KeychainKey.workspaceId)
		}
	}

	func logOut() {
		apiKey = nil
		actorId = nil
		actorName = nil
		workspaceId = nil
		Keychain.removeAll()
	}
}
