import Foundation
import Observation

public protocol KeychainAPI: Sendable {
	func credentials() async throws -> [KeychainCredential]
	/// The workspace's agents, for the "who can use it" list.
	func agents() async throws -> [KeychainAgent]
	/// Replaces every agent grant with read-and-write for exactly these agents.
	func setAgents(credentialID: String, agentIDs: [String]) async throws
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
	public private(set) var agents: [KeychainAgent] = []
	public private(set) var phase: Phase = .idle
	public private(set) var actionError: String?
	public private(set) var isBusy = false
	public private(set) var audit: [KeychainAuditEntry] = []
	public private(set) var auditNext: String?
	public private(set) var auditFailed = false

	@ObservationIgnored private let api: any KeychainAPI
	/// Names for the actors in the activity list (agents and people).
	@ObservationIgnored private let actorName: @Sendable (String) -> String?

	public init(api: any KeychainAPI, actorName: @escaping @Sendable (String) -> String? = { _ in nil }) {
		self.api = api
		self.actorName = actorName
	}

	public func load() async {
		if credentials.isEmpty { phase = .loading }
		do {
			async let loaded = api.credentials()
			async let team = api.agents()
			credentials = try await loaded.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
			agents = (try? await team) ?? agents
			phase = .loaded
		} catch {
			let message = (error as? KeychainAccessError)?.message ?? "Couldn't load your credentials."
			if credentials.isEmpty { phase = .failed(message) } else { actionError = message }
		}
	}

	public func credential(_ id: String) -> KeychainCredential? { credentials.first { $0.id == id } }

	public func agentName(_ id: String) -> String { agents.first { $0.id == id }?.name ?? actorName(id) ?? "Unknown agent" }

	/// "No agents can use it", "Infra", or "Infra + 2 more": names, never ids.
	public func scopeSummary(_ credential: KeychainCredential) -> String {
		let names = credential.agentIDs.map(agentName)
		guard let first = names.first else { return "No agents can use it" }
		return names.count > 1 ? "\(first) + \(names.count - 1) more" : first
	}

	@discardableResult
	public func setAgents(of credential: KeychainCredential, to ids: [String]) async -> Bool {
		await perform("Couldn't update access.") {
			try await self.api.setAgents(credentialID: credential.id, agentIDs: ids)
			if let index = self.credentials.firstIndex(where: { $0.id == credential.id }) {
				self.credentials[index].agentIDs = ids
			}
		}
	}

	@discardableResult
	public func remove(_ credential: KeychainCredential) async -> Bool {
		await perform("Couldn't remove it.") {
			try await self.api.remove(credentialID: credential.id)
			self.credentials.removeAll { $0.id == credential.id }
		}
	}

	@discardableResult
	public func add(name: String, value: KeychainNewValue) async -> Bool {
		let saved = await perform("Couldn't save it.") { _ = try await self.api.add(name: name, value: value) }
		if saved { await load() }
		return saved
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
		entry.sentence(actorName: agentName(entry.actorID))
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
