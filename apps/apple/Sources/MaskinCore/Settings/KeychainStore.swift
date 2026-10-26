import Foundation
import Observation

public protocol KeychainAPI: Sendable {
	func credentials() async throws -> [KeychainCredential]
	/// Everyone in the workspace: agents for the "who can use it" list, and names for the activity.
	func members() async throws -> [KeychainMember]
	/// Sets one agent's explicit row: read-and-write, `none` (off even when the default is on), or
	/// nil to remove the row so the agent falls back to the default. One agent at a time, as the web
	/// does, so a stale screen can never overwrite a grant made elsewhere.
	func setAccess(credentialID: String, agentID: String, to grant: KeychainGrant?) async throws
	/// Removes the credential; the secret is destroyed on the server.
	func remove(credentialID: String) async throws
	func audit(credentialID: String, before: String?) async throws -> KeychainAuditPage
	func add(name: String, value: KeychainNewValue) async throws -> String
}

/// The Keychain settings page: the credentials, who may use each, and the activity on one.
@MainActor
@Observable
public final class KeychainStore {
	public enum Phase: Equatable, Sendable {
		case idle, loading, loaded
		case failed(String)
	}

	public private(set) var credentials: [KeychainCredential] = []
	public private(set) var members: [KeychainMember] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var isBusy = false
	public private(set) var audit: [KeychainAuditEntry] = []
	public private(set) var auditNext: String?
	public private(set) var auditFailed = false

	@ObservationIgnored private let api: any KeychainAPI
	@ObservationIgnored private let currentActorID: String
	/// Owners and admins may remove any credential; anyone else only their own.
	@ObservationIgnored private let canManageWorkspace: Bool

	public init(api: any KeychainAPI, currentActorID: String = "", canManageWorkspace: Bool = false) {
		self.api = api
		self.currentActorID = currentActorID
		self.canManageWorkspace = canManageWorkspace
	}

	public var agents: [KeychainMember] { members.filter(\.isAgent) }

	public func load() async {
		if credentials.isEmpty { phase = .loading }
		do {
			async let loaded = api.credentials()
			async let team = api.members()
			credentials = try await loaded.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
			members = (try? await team) ?? members
			phase = .loaded
		} catch {
			let message = (error as? KeychainAccessError)?.message ?? "Couldn't load your credentials."
			if credentials.isEmpty { phase = .failed(message) } else { actionError = message }
		}
	}

	public func credential(_ id: String) -> KeychainCredential? { credentials.first { $0.id == id } }

	/// The agents that may use it, as the server decides (an explicit `none` row is off).
	public func agentsWithAccess(_ credential: KeychainCredential) -> [KeychainMember] {
		agents.filter { credential.allows($0.id) }
	}

	/// "No agents can use it", "All agents", "Infra" or "Infra + 2 more": names, never ids.
	public func scopeSummary(_ credential: KeychainCredential) -> String {
		let on = agentsWithAccess(credential)
		if on.isEmpty { return "No agents can use it" }
		if credential.defaultOn, on.count == agents.count, agents.count > 1 { return "All agents" }
		return on.count > 1 ? "\(on[0].name) + \(on.count - 1) more" : on[0].name
	}

	/// A person or agent's name for the activity list: "You" for yourself, never an id.
	public func actorName(_ id: String) -> String {
		if id == currentActorID { return "You" }
		return members.first { $0.id == id }?.name ?? "Someone"
	}

	/// Whether the Remove button is offered: the person who saved it, or an owner or admin.
	public func canRemove(_ credential: KeychainCredential) -> Bool {
		credential.createdByID == currentActorID || canManageWorkspace
	}

	/// Makes exactly the ticked agents the ones that may use it. Only the agents that changed are
	/// written, one call each, so a grant made elsewhere while the sheet was open is not undone.
	/// Turning an agent off writes an explicit `none` row when the default is on (removing the row
	/// would leave it on), and removes the row when the default is off.
	@discardableResult
	public func setAccess(of credential: KeychainCredential, to chosen: Set<String>) async -> Bool {
		var updated = credential
		let saved = await perform("Couldn't update access.") {
			for agent in self.agents where credential.allows(agent.id) != chosen.contains(agent.id) {
				let grant: KeychainGrant? =
					chosen.contains(agent.id) ? .readWrite : (credential.defaultOn ? KeychainGrant.none : nil)
				try await self.api.setAccess(credentialID: credential.id, agentID: agent.id, to: grant)
				updated.grants[agent.id] = grant
			}
		}
		// Keep what was written even if a later agent failed, so the screen tells the truth.
		if let index = credentials.firstIndex(where: { $0.id == credential.id }) { credentials[index] = updated }
		return saved
	}

	@discardableResult
	public func remove(_ credential: KeychainCredential) async -> Bool {
		await perform("Couldn't remove it.") {
			try await self.api.remove(credentialID: credential.id)
			self.credentials.removeAll { $0.id == credential.id }
		}
	}

	/// Saves a credential and, when `agentIDs` is not empty, shares it with exactly those agents.
	/// If the credential saved but sharing it failed, it is still in the Keychain and the error says
	/// so; `didSave` reports whether it was saved either way.
	@discardableResult
	public func add(name: String, value: KeychainNewValue, agentIDs: [String] = []) async -> AddOutcome {
		var credentialID = ""
		let saved = await perform("Couldn't save it.") { credentialID = try await self.api.add(name: name, value: value) }
		guard saved else { return .notSaved }
		var shared = true
		if !agentIDs.isEmpty, !credentialID.isEmpty {
			shared = await perform(
				"Saved, but couldn't share it with the agents. Open it in the Keychain to choose who can use it."
			) {
				for id in agentIDs { try await self.api.setAccess(credentialID: credentialID, agentID: id, to: .readWrite) }
			}
		}
		await load()
		return shared ? .saved : .savedNotShared
	}

	public enum AddOutcome: Equatable, Sendable {
		case notSaved
		/// In the Keychain, but sharing it with the agents failed.
		case savedNotShared
		case saved

		/// The credential exists, whether or not it was shared.
		public var didSave: Bool { self != .notSaved }
	}

	public func loadAudit(for credential: KeychainCredential, more: Bool = false) async {
		if !more { audit = []; auditNext = nil }
		do {
			let page = try await api.audit(credentialID: credential.id, before: more ? auditNext : nil)
			audit += page.entries
			auditNext = page.nextBeforeID
			auditFailed = false
		} catch {
			auditFailed = true
		}
	}

	public func sentence(for entry: KeychainAuditEntry) -> String {
		entry.sentence(actorName: actorName(entry.actorID))
	}

	public func dismissError() { actionError = nil }

	private func perform(_ fallback: String, _ work: @MainActor () async throws -> Void) async -> Bool {
		isBusy = true
		actionError = nil
		defer { isBusy = false }
		do {
			try await work()
			return true
		} catch {
			actionError = (error as? KeychainAccessError)?.message ?? fallback
			return false
		}
	}
}
