import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

// MARK: Model

enum AgentAccessLevel: String, CaseIterable, Sendable {
	case none, read, readWrite = "read_write"

	/// The words the web and the MCP use (`AGENT_ACCESS_LABELS`).
	var label: String {
		switch self {
		case .none: "No access"
		case .read: "Read"
		case .readWrite: "Read & write"
		}
	}
}

/// One GitHub connection (one installation) with its scopes and who may use it.
struct GitHubInstallation: Identifiable, Equatable, Sendable {
	var id: String
	var owner: String
	var isActive: Bool
	var needsReconnect: Bool
	var grantedScopes: [String]
	var missingScopes: [String]
	var defaultAccess: AgentAccessLevel
	var grants: [String: AgentAccessLevel]

	static func parse(_ json: Any?) -> [GitHubInstallation] {
		(json as? [[String: Any]] ?? []).compactMap { row in
			guard row["provider"] as? String == "github", let id = row["id"] as? String else { return nil }
			let config = row["config"] as? [String: Any]
			let owner = (config?["owner_login"] as? String).flatMap { $0.isEmpty ? nil : $0 }
				?? (row["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "GitHub account"
			var grants: [String: AgentAccessLevel] = [:]
			for g in row["agentGrants"] as? [[String: Any]] ?? [] {
				if let actor = g["actorId"] as? String, let level = AgentAccessLevel(rawValue: g["access"] as? String ?? "") {
					grants[actor] = level
				}
			}
			let missing = row["missingScopes"] as? [String] ?? []
			return GitHubInstallation(
				id: id, owner: owner, isActive: row["status"] as? String == "active",
				needsReconnect: row["needsReconnect"] as? Bool ?? !missing.isEmpty,
				grantedScopes: row["grantedScopes"] as? [String] ?? [], missingScopes: missing,
				defaultAccess: AgentAccessLevel(rawValue: row["defaultAgentAccess"] as? String ?? "") ?? .read,
				grants: grants)
		}
		.sorted { $0.owner.localizedStandardCompare($1.owner) == .orderedAscending }
	}

	/// What this agent can do here: its own row, else the default.
	func access(for actorId: String) -> (level: AgentAccessLevel, isDefault: Bool) {
		if let level = grants[actorId] { return (level, false) }
		return (defaultAccess, true)
	}
}

// MARK: Store

protocol GitHubAccessAPI: Sendable {
	func installations() async throws -> [GitHubInstallation]
	func setAccess(integrationId: String, actorId: String, level: AgentAccessLevel?) async throws
}

struct HTTPGitHubAccessSource: GitHubAccessAPI {
	let http: SettingsHTTP

	func installations() async throws -> [GitHubInstallation] {
		let reply = try await http.send("GET", "api/integrations")
		guard reply.ok else { throw SettingsError("Couldn't load GitHub.") }
		return GitHubInstallation.parse(reply.json)
	}

	/// A level sets the agent's own row; nil removes it so the agent follows the default again.
	func setAccess(integrationId: String, actorId: String, level: AgentAccessLevel?) async throws {
		let path = "api/integrations/\(integrationId)/grants/\(actorId)"
		let reply =
			if let level { try await http.send("PUT", path, body: ["access": level.rawValue]) }
			else { try await http.send("DELETE", path) }
		switch reply.status {
		case 200..<300: return
		case 403: throw SettingsError("Only a person can change who can use GitHub.")
		default: throw SettingsError("Couldn't change access.")
		}
	}
}

@MainActor
@Observable
final class GitHubAccessStore {
	enum Phase: Equatable { case idle, loading, loaded, failed(String) }

	private(set) var installations: [GitHubInstallation] = []
	private(set) var phase: Phase = .idle
	private(set) var error: String?
	@ObservationIgnored private let api: any GitHubAccessAPI
	let canManage: Bool

	init(api: any GitHubAccessAPI, canManage: Bool) {
		self.api = api
		self.canManage = canManage
	}

	func load() async {
		if installations.isEmpty { phase = .loading }
		do {
			installations = try await api.installations()
			phase = .loaded
		} catch {
			if installations.isEmpty {
				phase = .failed((error as? SettingsError)?.message ?? "Couldn't load GitHub.")
			}
		}
	}

	/// Optimistic; rolls back when the server refuses.
	func setAccess(_ level: AgentAccessLevel?, actorId: String, in installationId: String) async {
		guard canManage, let index = installations.firstIndex(where: { $0.id == installationId }) else { return }
		let before = installations
		installations[index].grants[actorId] = level
		error = nil
		do {
			try await api.setAccess(integrationId: installationId, actorId: actorId, level: level)
		} catch {
			installations = before
			self.error = (error as? SettingsError)?.message ?? "Couldn't change access."
		}
	}
}

// MARK: View

/// GitHub (2f): the connected accounts, whether their permissions are up to date (with
/// Reconnect), and which agents may use each. Agents are the workspace's agent members.
struct GitHubIntegrationPage: View {
	@State private var store: GitHubAccessStore
	let integrations: IntegrationsStore
	let members: MembersStore
	private var agents: [WorkspaceMember] {
		members.agents.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
	}
	@State private var picking: (installation: GitHubInstallation, agent: WorkspaceMember)?

	init(store: GitHubAccessStore, integrations: IntegrationsStore, members: MembersStore) {
		_store = State(initialValue: store)
		self.integrations = integrations
		self.members = members
	}

	var body: some View {
		WorkspacePage(title: "GitHub") {
			if store.installations.isEmpty {
				switch store.phase {
				case .failed(let message): PageStatus(text: message)
				case .loaded: PageStatus(text: "GitHub isn't connected.")
				default: PageStatus(text: "Loading GitHub")
				}
			}
			if !store.installations.isEmpty {
				PageGroupLabel(text: "Installations")
				PageCard(rows: store.installations.map(installationRow))
			}
			ForEach(store.installations) { install in
				if !install.missingScopes.isEmpty || !install.grantedScopes.isEmpty {
					PageGroupLabel(text: store.installations.count > 1 ? "Scopes \u{00B7} \(install.owner)" : "Scopes")
					PageCard(rows: scopeRows(install))
					if install.needsReconnect, store.canManage {
						Button("Reconnect \(install.owner)") { Task { await reconnect() } }
							.buttonStyle(.primaryAction)
							.disabled(integrations.isConnectInFlight)
					}
				}
			}
			ForEach(store.installations) { install in
				PageGroupLabel(
					text: store.installations.count > 1 ? "Agent access \u{00B7} \(install.owner)" : "Agent access")
				if agents.isEmpty {
					PageStatus(text: "No agents in this workspace yet.")
				} else {
					PageCard(rows: agents.map { accessRow(install, $0) })
				}
			}
			if let error = store.error { FormError(error) }
			if let notice = integrations.connectNotice {
				if notice.kind == .failure { FormError(notice.text) } else { PageFootnote(text: notice.text) }
			}
			if !store.installations.isEmpty {
				PageFootnote(
					text: store.canManage
						? "Agents without their own setting follow the default. Read & write lets an agent change things on GitHub."
						: "Only owners and admins can change who can use GitHub.")
			}
		}
		.task {
			await members.load()
			await store.load()
		}
		.refreshable { await store.load() }
		.onChange(of: integrations.connectPhase) { _, phase in
			if phase == .idle { Task { await store.load() } }
		}
		.confirmationDialog(
			picking.map { "\($0.agent.name) on \($0.installation.owner)" } ?? "Access",
			isPresented: Binding(get: { picking != nil }, set: { if !$0 { picking = nil } }),
			titleVisibility: .visible, presenting: picking
		) { pick in
			ForEach(AgentAccessLevel.allCases, id: \.self) { level in
				Button(level.label) {
					Task { await store.setAccess(level, actorId: pick.agent.actorId, in: pick.installation.id) }
				}
			}
			if pick.installation.grants[pick.agent.actorId] != nil {
				Button("Follow the default (\(pick.installation.defaultAccess.label))") {
					Task { await store.setAccess(nil, actorId: pick.agent.actorId, in: pick.installation.id) }
				}
			}
		}
	}

	private func reconnect() async { await integrations.connect(providerID: "github") }

	private func installationRow(_ install: GitHubInstallation) -> PageRowModel {
		PageRowModel(
			id: install.id, title: install.owner,
			subtitle: install.needsReconnect ? "Needs new permissions" : nil,
			accessory: .state(
				!install.isActive ? PageState("Reconnect", .notice)
					: install.needsReconnect ? PageState("Update needed", .notice) : PageState("Active", .active)))
	}

	private func scopeRows(_ install: GitHubInstallation) -> [PageRowModel] {
		install.grantedScopes.map {
			PageRowModel(id: "g-\(install.id)-\($0)", title: $0, accessory: .state(PageState("Granted", .active)))
		}
			+ install.missingScopes.map {
				PageRowModel(
					id: "m-\(install.id)-\($0)", title: $0, subtitle: "Reconnect to approve.",
					accessory: .state(PageState("Requested", .notice)))
			}
	}

	private func accessRow(_ install: GitHubInstallation, _ agent: WorkspaceMember) -> PageRowModel {
		let access = install.access(for: agent.actorId)
		return PageRowModel(
			id: "\(install.id)-\(agent.actorId)", title: agent.name,
			subtitle: access.isDefault ? "Default" : nil,
			avatar: (agent.name, true),
			accessory: .state(PageState(access.level.label, access.level == .none ? .muted : .plain)),
			action: store.canManage ? { picking = (install, agent) } : nil)
	}
}
