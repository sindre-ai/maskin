import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The pill under a group chat's title: overlapping avatars, who is in it, and a chevron. Opens
/// the People sheet.
struct GroupHeaderPill: View {
	let participants: [ChatParticipant]
	let selfID: String
	let action: () -> Void

	var body: some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s4) {
				HStack(spacing: -MaskinSpace.s2) {
					ForEach(GroupChatSummary.avatarParticipants(of: participants, selfID: selfID)) { p in
						ActorAvatar(
							name: p.name, kind: p.kind == .agent ? .agent : .human, size: MaskinSpace.s13 - MaskinSpace.s1,
							seed: p.id
						)
					}
				}
				Text(GroupChatSummary.names(of: participants, selfID: selfID))
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink2).lineLimit(1)
				Image(systemName: "chevron.right").font(.caption2).foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s3)
			.background(MaskinSurface.fill, in: Capsule())
			.contentShape(Capsule())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("People in this chat: \(GroupChatSummary.names(of: participants, selfID: selfID))")
		.accessibilityHint("Shows who is in the chat")
	}
}

/// Who is in the conversation, with a role line, and adding more. An agent's role is its own
/// description; people show as "Human" until member roles are available here.
struct PeopleSheet: View {
	let chat: ChatStore
	let conversations: ConversationsStore

	@Environment(\.dismiss) private var dismiss
	@State private var adding: Bool
	@State private var selection: Set<String> = []
	@State private var query = ""
	@State private var removeTarget: ChatParticipant?

	init(
		chat: ChatStore, conversations: ConversationsStore, startAdding: Bool = false
	) {
		self.chat = chat
		self.conversations = conversations
		_adding = State(initialValue: startAdding)
	}

	var body: some View {
		NavigationStack {
			List {
				if adding {
					ActorPickerList(
						actors: conversations.actors, excluding: Set(chat.participants.map(\.id)),
						selection: $selection, query: query)
				} else {
					Section {
						ForEach(chat.participants) { person in row(person) }
						Button {
							adding = true
						} label: {
							Label("Add someone", systemImage: "person.badge.plus")
						}
					}
				}
			}
			.confirmationDialog(
				"Remove from this conversation?",
				isPresented: Binding(get: { removeTarget != nil }, set: { if !$0 { removeTarget = nil } }),
				titleVisibility: .visible, presenting: removeTarget
			) { person in
				Button("Remove \(person.name)", role: .destructive) {
					Task { await chat.removeParticipant(person.id) }
				}
			} message: { person in
				Text("\(person.name) will no longer see new messages here.")
			}
			.searchable(text: $query, isPresented: .constant(adding), prompt: "Search people and agents")
			.navigationTitle(adding ? "Add people" : "People · \(chat.participants.count)")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(adding ? "Back" : "Done") { if adding { adding = false } else { dismiss() } }
				}
				if adding {
					ToolbarItem(placement: .confirmationAction) {
						Button("Add") {
							Task {
								await chat.addParticipants(Array(selection))
								selection = []
								adding = false
							}
						}
						.disabled(selection.isEmpty)
					}
				}
			}
			.task { await conversations.loadActors() }
		}
	}

	private func row(_ person: ChatParticipant) -> some View {
		let isSelf = person.id == chat.currentActorID
		return HStack(spacing: MaskinSpace.s7) {
			ActorAvatar(
				name: person.name, kind: person.kind == .agent ? .agent : .human,
				size: MaskinSpace.s14 + MaskinSpace.s3, seed: person.id,
				working: chat.agentStates[person.id] == .running)
			VStack(alignment: .leading, spacing: 0) {
				Text(isSelf ? "\(person.name) (you)" : person.name)
					.maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				Text(roleLine(person)).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .combine)
		.swipeActions(edge: .trailing, allowsFullSwipe: false) {
			if !isSelf { Button("Remove", role: .destructive) { removeTarget = person } }
		}
	}

	private func roleLine(_ person: ChatParticipant) -> String {
		PersonRoleLabel.label(
			for: person, memberRole: nil,
			agentSummary: chat.workspaceActors.first { $0.id == person.id }?.summary)
	}
}
