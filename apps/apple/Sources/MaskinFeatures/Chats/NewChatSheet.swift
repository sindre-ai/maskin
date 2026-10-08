import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Start a conversation: a "To" line of chosen actors (the Chief of Staff to begin with), an "Add
/// someone" row of everyone else, and the first message. More than one actor makes a group chat.
struct NewChatSheet: View {
	let store: ConversationsStore
	let currentActorID: String?
	var prefill = ""
	let onCreated: (ConversationSummary) -> Void

	@Environment(\.dismiss) private var dismiss
	@State private var draft = NewConversationDraft()
	@State private var message = ""
	@State private var isCreating = false
	@State private var error: String?
	@FocusState private var messageFocused: Bool
	#if os(iOS)
	@State private var dictation = Dictation()
	@State private var dictationBase = ""
	/// The message from before the mic opened, put back by Discard.
	@State private var textBeforeDictation = ""
	#endif

	private var recipients: [ChatActor] {
		draft.recipientIDs.compactMap { id in store.actors.first { $0.id == id } }
	}

	private var canSend: Bool {
		!recipients.isEmpty && !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
			&& message.count <= ChatLimits.maxMessageLength && !isCreating
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s9) {
					section("To") { toRow }
					let addable = draft.addable(from: store.actors, excluding: currentActorID)
					if !addable.isEmpty { section("Add someone") { addRow(addable) } }
					if let error { FormError(error) }
					messageBox
				}
				.padding(MaskinSpace.s9)
			}
			.scrollDismissesKeyboard(.interactively)
			.navigationTitle("New conversation")
			#if os(iOS)
			.navigationBarTitleDisplayMode(.inline)
			#endif
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
			.overlay { if isCreating { ProgressView() } }
			.task {
				await store.loadActors()
				draft.applyDefault(actors: store.actors, excluding: currentActorID)
				if message.isEmpty { message = prefill }
				messageFocused = true
			}
			.onDisappear {
				#if os(iOS)
				dictation.stop()
				#endif
			}
		}
	}

	private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text(title.uppercased()).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
			content()
		}
	}

	/// Chosen actors: avatar, name, and a cross to take them off.
	private var toRow: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				if recipients.isEmpty {
					Text("Choose who to talk to").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
				ForEach(recipients) { actor in
					Button {
						draft.remove(actor.id)
						MaskinHaptics.play(.selection)
					} label: {
						HStack(spacing: MaskinSpace.s3) {
							ActorAvatar(
								name: actor.participant.name, kind: actor.participant.kind == .agent ? .agent : .human,
								size: MaskinSpace.s12, seed: actor.id)
							Text(actor.participant.name).maskinText(.subhead)
							Image(systemName: "xmark").font(.caption2).accessibilityHidden(true)
						}
						.foregroundStyle(MaskinColor.accentStrong)
						.padding(.leading, MaskinSpace.s2)
						.padding(.trailing, MaskinSpace.s5)
						.padding(.vertical, MaskinSpace.s2)
						.background(MaskinColor.accentTint2, in: Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
					.accessibilityLabel("Remove \(actor.participant.name)")
				}
			}
		}
	}

	/// Everyone else, one tap to add.
	private func addRow(_ actors: [ChatActor]) -> some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s7) {
				ForEach(actors) { actor in
					Button {
						draft.toggle(actor.id)
						MaskinHaptics.play(.selection)
					} label: {
						VStack(spacing: MaskinSpace.s3) {
							ActorAvatar(
								name: actor.participant.name, kind: actor.participant.kind == .agent ? .agent : .human,
								size: MaskinSpace.s14 + MaskinSpace.s11, seed: actor.id)
							Text(actor.participant.name).maskinText(.caption).foregroundStyle(MaskinColor.ink3)
								.lineLimit(1)
						}
						.frame(width: MaskinSpace.s14 * 2 + MaskinSpace.s9)
					}
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("Add \(actor.participant.name)")
				}
			}
		}
	}

	private var isDictating: Bool {
		#if os(iOS)
		dictation.isListening
		#else
		false
		#endif
	}

	private var messageBox: some View {
		VStack(spacing: MaskinSpace.s5) {
			if isDictating {
				dictatingRow
			} else {
				messageField
				HStack {
					micButton
					Spacer()
					Button {
						Task { await create() }
					} label: {
						Label("Send", systemImage: "arrow.up").labelStyle(.titleAndIcon)
					}
					.buttonStyle(.borderedProminent)
					.tint(MaskinSurface.inverse)
					.disabled(!canSend)
					.keyboardShortcut(.return, modifiers: .command)
				}
			}
		}
		.padding(MaskinSpace.s8)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
	}

	private var messageField: some View {
		TextField(
			recipients.isEmpty ? "Message" : "Message \(recipients.map(\.participant.name).joined(separator: ", "))",
			text: $message, axis: .vertical
		)
		.focused($messageFocused)
		.font(MaskinTypeface.sans(MaskinFontSize.t17))
		.lineLimit(5...5)
		.frame(maxWidth: .infinity, alignment: .topLeading)
	}

	/// Recording, as in the chat composer: Discard, a red waveform with the editable transcript, Done.
	private var dictatingRow: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			DictationDiscardButton { discardDictation() }
			HStack(alignment: .top, spacing: MaskinSpace.s5) {
				VoiceWaveform(bars: 5, height: 22, tint: MaskinColor.dangerMic)
					.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s3)
				TextField("Listening…", text: $message, axis: .vertical)
					.focused($messageFocused)
					.font(MaskinTypeface.sans(MaskinFontSize.t17))
					.lineLimit(5...5)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.s14 + MaskinSpace.s3, alignment: .topLeading)
			}
			DictationDoneButton { finishDictation() }
		}
	}

	@ViewBuilder
	private var micButton: some View {
		#if os(iOS)
		Button {
			toggleDictation()
		} label: {
			Image(systemName: "mic.fill")
				.foregroundStyle(MaskinColor.ink3)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.background(MaskinSurface.fill, in: Circle())
		}
		.buttonStyle(.maskinPressed(.shrink))
		.accessibilityLabel("Dictate")
		#endif
	}

	#if os(iOS)
	private func toggleDictation() {
		if dictation.isListening {
			finishDictation()
			return
		}
		textBeforeDictation = message
		dictationBase = message
		Task {
			await dictation.start(continuous: true) { message = DictationText.merge(base: dictationBase, transcript: $0) }
			if case .unavailable(let reason) = dictation.state {
				error = reason
				dictation.clearError()
			}
		}
	}
	#endif

	/// Done: keep the text, ready to edit or send.
	private func finishDictation() {
		#if os(iOS)
		dictation.stop()
		#endif
		messageFocused = true
	}

	/// Discard: stop and put back the message from before the mic opened.
	private func discardDictation() {
		#if os(iOS)
		dictation.stop()
		message = textBeforeDictation
		#endif
	}

	private func create() async {
		let people = recipients
		guard !people.isEmpty else { return }
		#if os(iOS)
		dictation.stop()
		#endif
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
