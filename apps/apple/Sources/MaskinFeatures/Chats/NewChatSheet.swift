import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Start a conversation: the "To" field is focused on open, so you can type a name straight away;
/// pick one or more agents (recent ones first), write the message, send. Titles come later.
struct NewChatSheet: View {
	let store: ConversationsStore
	let currentActorID: String?
	var prefill = ""
	let onCreated: (ConversationSummary) -> Void

	private enum Field { case to, message }

	@Environment(\.dismiss) private var dismiss
	@State private var selection: Set<String> = []
	@State private var message = ""
	@State private var query = ""
	@State private var isCreating = false
	@State private var error: String?
	@FocusState private var focus: Field?

	/// Chosen recipients in the order they were picked.
	@State private var picked: [String] = []

	private var recipients: [ChatActor] { picked.compactMap { id in store.actors.first { $0.id == id } } }

	private var canSend: Bool {
		!recipients.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& message.count <= ChatLimits.maxMessageLength && !isCreating
	}

	var body: some View {
		NavigationStack {
			VStack(spacing: 0) {
				toField
				Divider()
				List {
					if let error { Section { FormError(error) } }
					ActorPickerList(
						actors: store.actors,
						excluding: Set([currentActorID].compactMap { $0 }),
						selection: $selection, query: query,
						recent: store.recentCollaboratorIDs, includeSystem: true, showsRecent: true)
				}
				.listStyle(.plain)
				.scrollDismissesKeyboard(.interactively)
				messageBar
			}
			.navigationTitle("New chat")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
			.overlay { if isCreating { ProgressView() } }
			.onChange(of: selection) { old, new in
				picked = picked.filter(new.contains) + new.subtracting(picked).sorted()
				if new.count > old.count {
					query = ""
					focus = .message
				}
			}
			.task {
				focus = .to
				await store.loadActors()
				if message.isEmpty { message = prefill }
			}
		}
	}

	/// "To:" row — chips for who is in, then the search field.
	private var toField: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				Text("To").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				ForEach(recipients) { actor in
					Button {
						selection.remove(actor.id)
						MaskinHaptics.play(.selection)
					} label: {
						HStack(spacing: MaskinSpace.s3) {
							Text(actor.participant.name).maskinText(.subhead)
							Image(systemName: "xmark").font(.caption2).accessibilityHidden(true)
						}
						.foregroundStyle(MaskinColor.accentFgStrong)
						.padding(.horizontal, MaskinSpace.s5)
						.padding(.vertical, MaskinSpace.s3)
						.background(MaskinColor.accentTint2, in: Capsule())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Remove \(actor.participant.name)")
				}
				TextField(recipients.isEmpty ? "Search agents" : "Add more", text: $query)
					.focused($focus, equals: .to)
					.maskinText(.body)
					.frame(minWidth: 140)
					.submitLabel(.next)
					.onSubmit { pickFirstMatch() }
					#if os(iOS)
					.textInputAutocapitalization(.never)
					.autocorrectionDisabled()
					#endif
			}
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s5)
		}
	}

	private var messageBar: some View {
		HStack(alignment: .bottom, spacing: MaskinSpace.s5) {
			TextField(
				recipients.isEmpty ? "Message" : "Message \(recipients.map(\.participant.name).joined(separator: ", "))",
				text: $message, axis: .vertical
			)
			.focused($focus, equals: .message)
			.maskinText(.body)
			.lineLimit(1...5)
			.padding(.horizontal, MaskinSpace.s7)
			.padding(.vertical, MaskinSpace.s5)
			.background(MaskinColor.surfaceAlt, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl))
			Button {
				Task { await create() }
			} label: {
				Image(systemName: "arrow.up.circle.fill").font(.title)
			}
			.foregroundStyle(canSend ? MaskinColor.accent : MaskinColor.ink5)
			.disabled(!canSend)
			.keyboardShortcut(.return, modifiers: .command)
			.accessibilityLabel("Send")
		}
		.padding(MaskinSpace.s5)
		.background(.bar)
	}

	/// Return in the search field takes the top match, like a mail client's "To" field.
	private func pickFirstMatch() {
		let match = store.actors.first {
			$0.id != currentActorID && !selection.contains($0.id)
				&& $0.participant.name.localizedCaseInsensitiveContains(query)
		}
		if let match, !query.isEmpty { selection.insert(match.id) } else { focus = .message }
	}

	private func create() async {
		let people = recipients
		guard !people.isEmpty else { return }
		isCreating = true
		error = nil
		defer { isCreating = false }
		do {
			let created = try await store.create(
				title: ThreadLayout.defaultTitle(for: people.map(\.participant.name)),
				participantIDs: people.map(\.id), firstMessage: message)
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
