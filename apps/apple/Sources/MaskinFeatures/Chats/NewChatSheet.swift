import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Start a conversation: pick participants (people and agents), optionally name it and write the
/// first message.
struct NewChatSheet: View {
	let store: ConversationsStore
	let currentActorID: String?
	let onCreated: (ConversationSummary) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var title = ""
	@State private var firstMessage = ""
	@State private var selection: Set<String> = []
	@State private var query = ""
	@State private var isCreating = false
	@State private var error: String?

	var body: some View {
		NavigationStack {
			List {
				Section {
					TextField("Title (optional)", text: $title)
					TextField("First message (optional)", text: $firstMessage, axis: .vertical)
						.lineLimit(1...4)
				}
				if let error {
					Section { FormError(error) }
				}
				ActorPickerList(
					actors: store.actors, excluding: Set([currentActorID].compactMap { $0 }),
					selection: $selection, query: query)
			}
			.searchable(text: $query, prompt: "Search people and agents")
			.navigationTitle("New chat")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				ToolbarItem(placement: .confirmationAction) {
					Button("Start") { Task { await create() } }
						.disabled(selection.isEmpty || isCreating)
				}
			}
			.overlay { if isCreating { ProgressView() } }
			.task { await store.loadActors() }
		}
	}

	private func create() async {
		isCreating = true
		error = nil
		defer { isCreating = false }
		let names = store.actors.filter { selection.contains($0.id) }.map(\.participant.name)
		let finalTitle = title.trimmingCharacters(in: .whitespacesAndNewlines)
		do {
			let created = try await store.create(
				title: finalTitle.isEmpty ? ThreadLayout.defaultTitle(for: names) : finalTitle,
				participantIDs: Array(selection), firstMessage: firstMessage)
			MaskinHaptics.play(.success)
			onCreated(created)
			dismiss()
		} catch {
			self.error = (error as? ChatsError)?.message ?? error.localizedDescription
			MaskinHaptics.play(.error)
		}
	}
}

/// Who is in the conversation, plus adding more people or agents.
struct ParticipantsSheet: View {
	let chat: ChatStore
	let conversations: ConversationsStore

	@Environment(\.dismiss) private var dismiss
	@State private var adding = false
	@State private var selection: Set<String> = []
	@State private var query = ""

	var body: some View {
		NavigationStack {
			List {
				if adding {
					ActorPickerList(
						actors: conversations.actors, excluding: Set(chat.participants.map(\.id)),
						selection: $selection, query: query)
				} else {
					Section("In this conversation") {
						ForEach(chat.participants) { p in
							HStack(spacing: MaskinSpace.s7) {
								ActorAvatar(
									name: p.name, kind: p.kind == .agent ? .agent : .human,
									size: MaskinSpace.s13 + MaskinSpace.s3, seed: p.id,
									working: chat.agentStates[p.id] == .running)
								Text(p.name).maskinText(.body)
								Spacer()
								Text(p.kind == .agent ? "Agent" : "Person").maskinText(.caption)
									.foregroundStyle(MaskinColor.ink4)
							}
							.accessibilityElement(children: .combine)
						}
					}
				}
			}
			.searchable(text: $query, isPresented: .constant(adding), prompt: "Search people and agents")
			.navigationTitle(adding ? "Add people" : "People")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) {
					Button(adding ? "Back" : "Done") { if adding { adding = false } else { dismiss() } }
				}
				ToolbarItem(placement: .confirmationAction) {
					if adding {
						Button("Add") {
							Task {
								await chat.addParticipants(Array(selection))
								selection = []
								adding = false
							}
						}
						.disabled(selection.isEmpty)
					} else {
						Button("Add", systemImage: "person.badge.plus") {
							adding = true
							Task { await conversations.loadActors() }
						}
					}
				}
			}
		}
	}
}
