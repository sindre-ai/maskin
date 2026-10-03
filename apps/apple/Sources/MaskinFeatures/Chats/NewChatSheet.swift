import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Start a conversation: pick an agent, write the message, send. Titles and extra people come
/// later, inside the chat.
struct NewChatSheet: View {
	let store: ConversationsStore
	let currentActorID: String?
	var prefill = ""
	let onCreated: (ConversationSummary) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var agentID: String?
	@State private var message = ""
	@State private var query = ""
	@State private var isCreating = false
	@State private var error: String?
	@FocusState private var messageFocused: Bool

	private var agents: [ChatActor] {
		store.actors.filter {
			$0.participant.kind == .agent && $0.id != currentActorID
				&& (query.isEmpty || $0.participant.name.localizedCaseInsensitiveContains(query))
		}
		// The workspace's own agents (Chief of Staff) first, then the rest by name.
		.sorted { ($0.isSystem ? 0 : 1, $0.participant.name) < ($1.isSystem ? 0 : 1, $1.participant.name) }
	}

	private var selected: ChatActor? { store.actors.first { $0.id == agentID } }

	private var canSend: Bool {
		selected != nil && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& message.count <= ChatLimits.maxMessageLength && !isCreating
	}

	var body: some View {
		NavigationStack {
			Group {
				if let selected {
					compose(with: selected)
				} else {
					picker
				}
			}
			.navigationTitle("New chat")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
				if selected != nil {
					ToolbarItem(placement: .confirmationAction) {
						Button("Send") { Task { await create() } }
							.disabled(!canSend)
							.keyboardShortcut(.return, modifiers: .command)
					}
				}
			}
			.overlay { if isCreating { ProgressView() } }
			.task {
				await store.loadActors()
				if message.isEmpty { message = prefill }
			}
		}
	}

	/// Step 1: who do you want to talk to?
	private var picker: some View {
		List {
			if let error { Section { FormError(error) } }
			if agents.isEmpty {
				Text(query.isEmpty ? "No agents yet." : "No matches.").foregroundStyle(MaskinColor.ink4)
			}
			ForEach(agents) { agent in
				Button {
					agentID = agent.id
					messageFocused = true
					MaskinHaptics.play(.selection)
				} label: {
					HStack(spacing: MaskinSpace.s7) {
						ActorAvatar(
							name: agent.participant.name, kind: .agent,
							size: MaskinSpace.s13 + MaskinSpace.s3, seed: agent.id,
							working: agent.agentState == .running)
						VStack(alignment: .leading, spacing: 0) {
							Text(agent.participant.name).maskinText(.body).foregroundStyle(MaskinColor.ink)
							if let summary = agent.summary, !summary.isEmpty {
								Text(summary).maskinText(.caption).foregroundStyle(MaskinColor.ink4).lineLimit(2)
							}
						}
						Spacer(minLength: 0)
					}
					.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
			}
		}
		.listStyle(.plain)
		.searchable(text: $query, prompt: "Search agents")
	}

	/// Step 2: the agent chosen, write to it.
	private func compose(with agent: ChatActor) -> some View {
		VStack(spacing: 0) {
			Button {
				agentID = nil
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					ActorAvatar(
						name: agent.participant.name, kind: .agent, size: MaskinSpace.s13, seed: agent.id)
					Text(agent.participant.name).maskinText(.headline).foregroundStyle(MaskinColor.ink)
					Spacer(minLength: 0)
					Text("Change").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
				.padding(MaskinSpace.s8)
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel("Chatting with \(agent.participant.name). Change agent")
			Divider()
			if let error { FormError(error).padding(MaskinSpace.s8) }
			TextField("Message \(agent.participant.name)", text: $message, axis: .vertical)
				.focused($messageFocused)
				.maskinText(.body)
				.padding(MaskinSpace.s8)
				.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
		}
		.onAppear { messageFocused = true }
	}

	private func create() async {
		guard let agent = selected else { return }
		isCreating = true
		error = nil
		defer { isCreating = false }
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: [agent.participant.name]),
				participantIDs: [agent.id], firstMessage: message)
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
	@State private var removeTarget: ChatParticipant?

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
							.swipeActions(edge: .trailing, allowsFullSwipe: false) {
								if p.id != chat.currentActorID {
									Button("Remove", role: .destructive) { removeTarget = p }
								}
							}
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
