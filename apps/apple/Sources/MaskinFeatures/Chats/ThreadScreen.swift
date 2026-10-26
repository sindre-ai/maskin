import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One thread: the message it hangs under, then the replies in order, and a reply bar. Replies
/// stay out of the chat's main timeline unless you tick "Also send to chat".
///
/// "To" names who the reply is for. They are mentioned, which is what makes an agent answer; with
/// more than one candidate the chip cycles through them.
struct ThreadScreen: View {
	let store: ChatStore
	let root: ChatMessage

	@State private var draft = ""
	@State private var alsoInChannel = false
	@State private var recipientIndex = 0
	@FocusState private var focused: Bool
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var rootID: Int? { root.serverID }

	/// The root as the store holds it (its summary refreshes); the one passed in when the thread was
	/// opened from the Threads list and the chat has not loaded it.
	private var shownRoot: ChatMessage {
		store.allMessages.first { $0.serverID == rootID } ?? root
	}

	private var replies: [ChatMessage] { rootID.map(store.replies(to:)) ?? [] }

	private var recipients: [ChatParticipant] {
		ThreadReplyTargets.candidates(
			rootAuthor: store.participant(for: root.actorID), participants: store.participants,
			currentActorID: store.currentActorID)
	}

	private var recipient: ChatParticipant? {
		recipients.isEmpty ? nil : recipients[recipientIndex % recipients.count]
	}

	var body: some View {
		VStack(spacing: 0) {
			ScrollViewReader { proxy in
				ScrollView {
					LazyVStack(alignment: .leading, spacing: MaskinSpace.s5) {
						row(shownRoot, showsAuthor: true)
						repliesDivider
						ForEach(Array(replies.enumerated()), id: \.element.id) { index, reply in
							row(reply, showsAuthor: index == 0 || replies[index - 1].actorID != reply.actorID)
								.id(reply.id)
						}
						Color.clear.frame(height: 1).id("end")
					}
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s5)
				}
				.scrollDismissesKeyboard(.interactively)
				.defaultScrollAnchor(.top)
				.onChange(of: replies.last?.id) { _, _ in
					withAnimation(MaskinMotion.standard) { proxy.scrollTo("end", anchor: .bottom) }
				}
			}
			replyBar
		}
		.background(MaskinSurface.grouped)
		.linkedItems(runtime)
		.navigationTitle("Thread")
		#if os(iOS)
		.navigationBarTitleDisplayMode(.inline)
		#endif
		.toolbar {
			ToolbarItem(placement: .principal) {
				VStack(spacing: 0) {
					Text("Thread").font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .bold, relativeTo: .headline))
					Text(subtitle).maskinText(.caption).foregroundStyle(MaskinColor.ink5)
				}
				.accessibilityElement(children: .combine)
			}
		}
		.task(id: rootID) {
			guard let rootID else { return }
			// The chat underneath stops its store when it leaves the screen; the thread keeps it
			// live (idempotent: a no-op while it is already running).
			await store.start()
			await store.loadThread(rootID)
			await store.markThreadRead(rootID)
		}
		// A reply that lands while the thread is open is read as it arrives.
		.onChange(of: replies.compactMap(\.serverID).last) { _, _ in
			guard let rootID else { return }
			Task { await store.markThreadRead(rootID) }
		}
	}

	private var subtitle: String {
		let who = shownRoot.actorName
		guard let date = shownRoot.createdAt else { return who }
		return "\(who) · \(ChatListTime.label(for: date, now: Date()))"
	}

	private var repliesDivider: some View {
		HStack(spacing: MaskinSpace.s5) {
			Text(replies.isEmpty ? "No replies yet" : ThreadSummary.label(count: replies.count, unread: 0))
				.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
				.foregroundStyle(MaskinColor.ink5)
			Rectangle().fill(MaskinSurface.line).frame(height: 1)
		}
		.padding(.vertical, MaskinSpace.s3)
		.accessibilityAddTraits(.isHeader)
	}

	private func row(_ message: ChatMessage, showsAuthor: Bool) -> some View {
		var actions = MessageMenuActions()
		if !message.content.isEmpty {
			actions.onCopy = {
				Clipboard.copy(message.content)
				MaskinHaptics.play(.selection)
			}
		}
		if message.serverID != nil, message.kind == "message", !message.isFailed {
			actions.reacted = Set(message.reactions.filter(\.reactedByMe).map(\.emoji))
			actions.onReact = { emoji in Task { await store.toggleReaction(emoji, on: message) } }
		}
		if message.isFailed {
			actions.onRetrySend = { store.retrySend(message.id) }
			actions.onDiscard = { store.discard(message.id) }
		}
		return MessageRow(
			message: message, isOwn: message.actorID == store.currentActorID, showsAuthor: showsAuthor,
			mentions: message.mentionIDs.compactMap { id in
				store.displayName(for: id).map { (id: id, name: $0) }
			},
			sendStatus: message.isPending ? MessageSendStatus.of(message, readBy: nil) : nil,
			actions: actions, onRetrySend: { store.retrySend(message.id) },
			onToggleReaction: { emoji in Task { await store.toggleReaction(emoji, on: message) } },
			onKeychainReply: { text, metadata in
				// The allow or save goes back into this thread, to the agent that asked.
				guard let rootID else { return }
				store.reply(
					text, in: rootID, to: message.author == .agent ? store.participant(for: message.actorID) : nil,
					alsoInChannel: false, metadata: metadata)
			},
			cardOutcome: message.serverID.flatMap { store.cardAnswerIndex[$0] },
			chatAgents: store.participants.filter { $0.kind == .agent },
			onApprovedDraft: { title, body in
				// The yes goes back into this thread, to the agent that wrote the draft.
				guard let rootID else { return }
				store.reply(
					LinkedDraftMessage.approved(title: title, body: body), in: rootID,
					to: message.author == .agent ? store.participant(for: message.actorID) : nil, alsoInChannel: false)
			})
	}

	// MARK: Reply bar

	private var replyBar: some View {
		VStack(spacing: MaskinSpace.s4) {
			HStack(spacing: MaskinSpace.s5) {
				if let recipient { recipientChip(recipient) }
				Spacer(minLength: 0)
				alsoToggle
			}
			HStack(spacing: MaskinSpace.s4) {
				TextField("Reply", text: $draft, axis: .vertical)
					.lineLimit(1...5)
					.focused($focused)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
					.submitLabel(.send)
					.onSubmit(send)
					.padding(.leading, MaskinSpace.s10)
					.padding(.vertical, MaskinSpace.s6)
				Button(action: send) {
					Image(systemName: "arrow.up")
						.maskinSymbol(MaskinFontSize.t18, weight: .bold)
						.foregroundStyle(canSend ? MaskinSurface.onInverse : MaskinColor.inkPlaceholder)
						.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
						.background(canSend ? MaskinSurface.inverse : MaskinSurface.fill, in: Circle())
				}
				.buttonStyle(.maskinPressed)
				.disabled(!canSend)
				.padding(.trailing, MaskinSpace.s2)
				.accessibilityLabel("Send reply")
			}
			.background(MaskinSurface.card, in: Capsule())
			.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.top, MaskinSpace.s4)
		.padding(.bottom, MaskinSpace.s5)
		.background(MaskinSurface.grouped)
	}

	private func recipientChip(_ person: ChatParticipant) -> some View {
		let chip = HStack(spacing: MaskinSpace.s3) {
			Text("To \(person.name)")
			if recipients.count > 1 {
				Image(systemName: "chevron.up.chevron.down").maskinSymbol(MaskinFontSize.t11, weight: .bold)
			}
		}
		.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .bold, relativeTo: .footnote))
		.foregroundStyle(MaskinColor.ink)
		.padding(.horizontal, MaskinSpace.s6)
		.frame(height: MaskinSpace.s14 + MaskinSpace.s2)
		.background(MaskinSurface.card, in: Capsule())
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Capsule())
		return Group {
			if recipients.count > 1 {
				Button {
					MaskinHaptics.play(.selection)
					recipientIndex = (recipientIndex + 1) % recipients.count
				} label: { chip }
					.buttonStyle(.maskinPressed)
					.accessibilityHint("Changes who the reply is for")
			} else {
				chip
			}
		}
	}

	private var alsoToggle: some View {
		Button {
			MaskinHaptics.play(.selection)
			alsoInChannel.toggle()
		} label: {
			HStack(spacing: MaskinSpace.s3) {
				Image(systemName: alsoInChannel ? "checkmark.square.fill" : "square")
					.maskinSymbol(MaskinFontSize.t18)
					.foregroundStyle(alsoInChannel ? MaskinColor.ink : MaskinColor.ink5)
				Text("Also send to chat")
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink2)
			}
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.accessibilityAddTraits(alsoInChannel ? [.isSelected] : [])
	}

	private var canSend: Bool {
		rootID != nil && !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
	}

	private func send() {
		guard canSend, let rootID else { return }
		guard store.reply(draft, in: rootID, to: recipient, alsoInChannel: alsoInChannel) != nil else { return }
		MaskinHaptics.play(.selection)
		draft = ""
		alsoInChannel = false
	}
}
