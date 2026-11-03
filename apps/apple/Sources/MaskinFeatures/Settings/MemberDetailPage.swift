import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Member detail (2k): who they are, their role and what it lets them do, and Remove. Owners and
/// admins change the role of anyone but an owner or themselves.
struct MemberDetailPage: View {
	let store: MembersStore
	let memberID: String
	@Environment(\.dismiss) private var dismiss
	@State private var confirmRemove = false

	var body: some View {
		if let member = store.members.first(where: { $0.id == memberID }) {
			WorkspacePage(title: member.name) {
				PageCard(rows: [
					PageRowModel(
						id: "who", title: member.name, subtitle: Self.joinedText(member),
						avatar: (member.name, member.isAgent),
						accessory: .state(WorkspacePageState.member(role: member.role)))
				])
				PageGroupLabel(text: "Role")
				PageCard(rows: roleRows(member))
				PageGroupLabel(text: "Access")
				PageCard(rows: accessRows(member))
				if let error = store.actionError { FormError(error) }
				if store.canRemove(member) {
					Button("Remove from workspace", role: .destructive) { confirmRemove = true }
						.buttonStyle(.secondaryAction)
				}
			}
			.confirmationDialog(
				"Remove \(member.name)?", isPresented: $confirmRemove, titleVisibility: .visible
			) {
				Button("Remove from workspace", role: .destructive) {
					Task { if await store.remove(member) { dismiss() } }
				}
			} message: {
				Text("\(member.name) loses access to this workspace right away.")
			}
		} else {
			PageStatus(text: "This person is no longer in the workspace.")
		}
	}

	static func joinedText(_ member: WorkspaceMember) -> String {
		let kind = member.isAgent ? "Agent" : member.role.label
		guard let joined = member.joinedAt else { return kind }
		return "\(kind) \u{00B7} Joined \(joined.formatted(.dateTime.month(.abbreviated).day()))"
	}

	private func roleRows(_ member: WorkspaceMember) -> [PageRowModel] {
		guard store.canChangeRole(of: member) else {
			return [PageRowModel(id: "role", title: member.role.label, accessory: .check)]
		}
		return [MemberRole.admin, .member].map { role in
			PageRowModel(
				id: role.rawValue, title: role.label,
				subtitle: role == .admin ? "Manages people and integrations" : "Works with items and agents",
				accessory: role == member.role ? .check : .none,
				action: role == member.role ? nil : { Task { await store.setRole(role, for: member) } })
		}
	}

	/// What the role allows. Every member can edit items and use agents; managers also run people
	/// and integrations. Read-only here: the API has no per-person access switches.
	private func accessRows(_ member: WorkspaceMember) -> [PageRowModel] {
		var rows = [
			PageRowModel(id: "edit", title: "Can edit items", accessory: .state(PageState("Yes", .active))),
			PageRowModel(id: "agents", title: "Can use agents", accessory: .state(PageState("Yes", .active))),
		]
		rows.append(
			PageRowModel(
				id: "manage", title: "Can manage people",
				accessory: .state(member.role.canManage ? PageState("Yes", .active) : PageState("No", .muted))))
		return rows
	}
}

/// A pending invitation: when it was sent, resend or cancel.
struct InvitationDetailPage: View {
	let store: PendingInvitesStore
	let inviteID: String
	@Environment(\.dismiss) private var dismiss
	@State private var resent = false

	var body: some View {
		if let invite = store.invites.first(where: { $0.id == inviteID }) {
			WorkspacePage(title: invite.email) {
				PageGroupLabel(text: "Invitation")
				PageCard(rows: [
					PageRowModel(
						id: "sent", title: "Sent", subtitle: invite.invitedBy.isEmpty ? nil : "By \(invite.invitedBy)",
						accessory: .state(PageState(invite.sentText().replacingOccurrences(of: "Invited ", with: "").capitalized, .plain))),
					PageRowModel(id: "role", title: "Role", accessory: .state(PageState(invite.role.label, .plain))),
				])
				if resent { PageFootnote(text: "Invitation sent again.") }
				if let error = store.error { FormError(error) }
				Button("Resend invitation") { Task { resent = await store.resend(invite) } }
					.buttonStyle(.primaryAction)
				Button("Cancel invitation", role: .destructive) {
					Task { if await store.cancel(invite) { dismiss() } }
				}
				.buttonStyle(.secondaryAction)
			}
		} else {
			PageStatus(text: "This invitation is gone.")
		}
	}
}
