import MaskinCore
import SwiftUI

/// A person who was invited and has not joined yet.
struct PendingInvite: Identifiable, Hashable, Sendable {
	var id: String
	var email: String
	var role: MemberRole
	var invitedBy: String
	var createdAt: Date?

	/// "Invited 2 days ago" or "Invited today".
	func sentText(now: Date = .now) -> String {
		guard let createdAt else { return "Invited" }
		let days = Calendar.current.dateComponents([.day], from: createdAt, to: now).day ?? 0
		switch days {
		case ..<1: return "Invited today"
		case 1: return "Invited yesterday"
		default: return "Invited \(days) days ago"
		}
	}

	static func parseList(_ json: Any?) -> [PendingInvite] {
		(json as? [[String: Any]] ?? []).compactMap { row in
			guard let id = row["id"] as? String, let email = row["email"] as? String else { return nil }
			return PendingInvite(
				id: id, email: email, role: MemberRole(serverValue: row["role"] as? String ?? "member"),
				invitedBy: row["invitedByName"] as? String ?? "",
				createdAt: SettingsHTTP.date(row["createdAt"]))
		}
		.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
	}
}

protocol PendingInvitesAPI: Sendable {
	func list() async throws -> [PendingInvite]
	func resend(id: String) async throws
	func revoke(id: String) async throws
}

struct HTTPPendingInvitesSource: PendingInvitesAPI {
	let http: SettingsHTTP

	func list() async throws -> [PendingInvite] {
		let reply = try await http.send("GET", "api/invites")
		guard reply.ok else { throw SettingsError("Couldn't load invitations.") }
		return PendingInvite.parseList(reply.json)
	}

	func resend(id: String) async throws {
		let reply = try await http.send("POST", "api/invites/\(id)/resend")
		guard reply.ok else { throw SettingsError("Couldn't send the invitation again.") }
	}

	func revoke(id: String) async throws {
		let reply = try await http.send("DELETE", "api/invites/\(id)")
		guard reply.ok else { throw SettingsError("Couldn't cancel the invitation.") }
	}
}

/// Pending invitations, for owners and admins (the API refuses everyone else, so the list stays
/// empty for them rather than showing an error).
@MainActor
@Observable
final class PendingInvitesStore {
	private(set) var invites: [PendingInvite] = []
	private(set) var error: String?
	private(set) var busy: Set<String> = []
	@ObservationIgnored private let api: any PendingInvitesAPI
	@ObservationIgnored private let canManage: Bool

	init(api: any PendingInvitesAPI, canManage: Bool) {
		self.api = api
		self.canManage = canManage
	}

	func load() async {
		guard canManage else { return }
		if let list = try? await api.list() { invites = list }
	}

	@discardableResult
	func resend(_ invite: PendingInvite) async -> Bool {
		await act(invite) { try await self.api.resend(id: invite.id) }
	}

	/// Optimistic: the row goes at once and comes back if the server refuses.
	@discardableResult
	func cancel(_ invite: PendingInvite) async -> Bool {
		let before = invites
		invites.removeAll { $0.id == invite.id }
		let ok = await act(invite) { try await self.api.revoke(id: invite.id) }
		if !ok { invites = before }
		return ok
	}

	private func act(_ invite: PendingInvite, _ call: () async throws -> Void) async -> Bool {
		guard canManage, !busy.contains(invite.id) else { return false }
		busy.insert(invite.id)
		error = nil
		defer { busy.remove(invite.id) }
		do {
			try await call()
			return true
		} catch {
			self.error = (error as? SettingsError)?.message ?? "Something went wrong."
			return false
		}
	}
}
