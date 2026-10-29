import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// New conversation (spec 7 §6b): a To card with chips and an inline field that filters people
/// and agents by name and role, N MATCHES / SUGGESTED rows with a 32pt +, the group note, starter
/// chips above the shared composer, and a draft that survives closing the sheet. The Chief of
/// Staff is on the line to begin with; more than one recipient makes a group chat.
struct NewChatSheet: View {
	let store: ConversationsStore
	let currentActorID: String?
	var prefill = ""
	var initialRecipient: ChatParticipant?
	/// `live` is true when the person chose Live: the caller opens the conversation straight into a call.
	let onCreated: (ConversationSummary, _ live: Bool) -> Void

	/// Where the unsent text lives between openings of the sheet.
	static let draftKey = "new-conversation"

	@Environment(\.dismiss) private var dismiss
	@State private var draft = NewConversationDraft()
	@State private var query = ""
	@State private var highlightedChip: String?
	@State private var restoredDraft = false
	@State private var isCreating = false
	@State private var error: String?
	@State private var composer: ChatComposerModel
	@FocusState private var toFocused: Bool

	init(
		store: ConversationsStore, currentActorID: String?, prefill: String = "",
		initialRecipient: ChatParticipant? = nil, uploader: (any ChatFileUploading)? = nil,
		onCreated: @escaping (ConversationSummary, _ live: Bool) -> Void
	) {
		self.store = store
		self.currentActorID = currentActorID
		self.prefill = prefill
		self.initialRecipient = initialRecipient
		self.onCreated = onCreated
		_composer = State(initialValue: ChatComposerModel(uploader: uploader, selfActorID: currentActorID ?? ""))
	}

	private var recipients: [ChatParticipant] {
		NewConversationForm.recipients(draft.recipientIDs, store: store, initialRecipient: initialRecipient)
	}

	var body: some View {
		NavigationStack {
			ScrollView {
				NewConversationForm(
					store: store, currentActorID: currentActorID, initialRecipient: initialRecipient, error: error,
					draft: $draft, query: $query, highlightedChip: $highlightedChip,
					toFocused: $toFocused)
			}
			.scrollDismissesKeyboard(.interactively)
			.ambientBackground(showsBottom: false)
			.safeAreaInset(edge: .bottom) { bottomBar }
			.toolbar {
				ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
			}
			#if os(iOS)
			.toolbarTitleDisplayMode(.inline)
			#endif
			.overlay { if isCreating { ProgressView() } }
			.task {
				if let initialRecipient, !draft.recipientIDs.contains(initialRecipient.id) { draft.toggle(initialRecipient.id) }
				await store.loadActors()
				draft.applyDefault(actors: store.actors, excluding: currentActorID)
				// The composer keeps the draft itself; text passed in wins over a saved draft.
				restoredDraft = prefill.isEmpty && ChatDraftStore.draft(for: Self.draftKey) != nil
				if !prefill.isEmpty { composer.text = prefill }
				composer.bind(conversationID: Self.draftKey)
				toFocused = draft.recipientIDs.isEmpty
			}
		}
	}

	// MARK: Composer

	/// Live needs exactly one agent to talk to; the composer shows its waveform button while the field is empty.
	private var liveLead: ChatParticipant? {
		recipients.count == 1 && recipients[0].kind == .agent && !isCreating ? recipients[0] : nil
	}

	private var bottomBar: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s5) {
			if !composer.trimmedText.isEmpty, restoredDraft {
				Text("Draft saved · ⌘↩ to send")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink5)
					.padding(.horizontal, MaskinSpace.s3)
			}
			MaskinComposer(
				model: composer,
				config: MaskinComposerConfig(
					variant: .floating, placeholder: NewConversationCopy.placeholder(for: recipients),
					// Live is the composer's own waveform button, as in every other chat.
					goLive: liveLead == nil ? nil : { Task { await send(live: true) } },
					suggestions: { query in
						MentionTrigger.candidates(
							query: query, participants: recipients, workspace: store.actors,
							selfID: currentActorID ?? "", excluding: Set(composer.mentions.map(\.id)))
					},
					inConversation: Set(draft.recipientIDs)),
				onSend: { Task { await send() } })
		}
		.padding(.horizontal, MaskinSpace.s7)
		.padding(.bottom, MaskinSpace.s4)
	}

	private func send(live: Bool = false) async {
		// @mentions in the text also join the conversation.
		var ids = draft.recipientIDs
		for mention in composer.mentions where !ids.contains(mention.id) && mention.id != currentActorID {
			ids.append(mention.id)
		}
		let people = NewConversationForm.recipients(ids, store: store, initialRecipient: initialRecipient)
		guard !people.isEmpty else { return }
		// Live starts the call with no first message; the typed text stays in the composer.
		let taken = live ? nil : composer.take()
		let message = taken?.text
		guard live || message != nil else { return }
		isCreating = true
		error = nil
		defer { isCreating = false }
		do {
			let created = try await store.create(
				title: ThreadLayout.newChatTitle(for: people.map(\.name), startsLiveCall: live),
				participantIDs: people.map(\.id), firstMessage: message,
				firstMessageMetadata: taken?.metadata)
			MaskinHaptics.play(.success)
			onCreated(created, live)
			dismiss()
		} catch {
			if let message { composer.text = message }
			self.error = (error as? ChatsError)?.message ?? error.localizedDescription
			MaskinHaptics.play(.error)
		}
	}
}

/// The sheet's scrolling content: title, the To card, the group note, and the people rows.
/// Separate from the sheet so it renders in a snapshot without the scroll view.
struct NewConversationForm: View {
	let store: ConversationsStore
	let currentActorID: String?
	var initialRecipient: ChatParticipant?
	var error: String?
	@Binding var draft: NewConversationDraft
	@Binding var query: String
	/// The last chip, after one Backspace on an empty field; a second Backspace removes it.
	@Binding var highlightedChip: String?
	var toFocused: FocusState<Bool>.Binding

	static func recipients(_ ids: [String], store: ConversationsStore, initialRecipient: ChatParticipant?) -> [ChatParticipant] {
		ids.compactMap { id in
			store.actors.first { $0.id == id }?.participant ?? (initialRecipient?.id == id ? initialRecipient : nil)
		}
	}

	private var recipients: [ChatParticipant] { Self.recipients(draft.recipientIDs, store: store, initialRecipient: initialRecipient) }

	/// Everyone but you: the Chief of Staff first, then agents, then people, each by name.
	private var candidates: [ChatActor] {
		draft.addable(from: store.actors, excluding: currentActorID)
	}

	private var matches: [ChatActor] { NewConversationCopy.matches(query, in: candidates, excluding: Set(draft.recipientIDs)) }
	private var isSearching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			Text("New conversation")
				.maskinText(.sheetTitle)
				.foregroundStyle(MaskinColor.ink)
			Text("Choose who's in it, then say what you need.")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink4)
				.padding(.top, MaskinSpace.s3)
			toCard.padding(.top, MaskinSpace.s9)
			if let note = NewConversationCopy.groupNote(recipientCount: recipients.count) {
				Text(note)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
					.fixedSize(horizontal: false, vertical: true)
					.padding(.top, MaskinSpace.s4)
					.padding(.horizontal, MaskinSpace.s2)
			}
			if let error { FormError(error).padding(.top, MaskinSpace.s7) }
			// The list only exists while To has focus, so no person row sits under the message box.
			if toFocused.wrappedValue {
				VStack(alignment: .leading, spacing: 0) { people }
					.transition(.opacity.combined(with: .offset(y: MaskinSpace.s4)))
			}
		}
		.animation(MaskinMotion.quick, value: toFocused.wrappedValue)
		.padding(.horizontal, MaskinSpace.s11)
		.padding(.top, MaskinSpace.s2)
		.padding(.bottom, MaskinSpace.s12)
	}

	// MARK: To card

	private var toCard: some View {
		FlowLayout(spacing: MaskinSpace.s3, alignment: .leading) {
			Text("To")
				.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink5)
				.padding(.trailing, MaskinSpace.s2)
				.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
			ForEach(recipients) { person in
				RecipientChip(person: person, highlighted: highlightedChip == person.id) { remove(person.id) }
			}
			TextField(recipients.isEmpty ? "Type a name or role" : "Add someone", text: $query)
				.focused(toFocused)
				.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
				.frame(minWidth: 120, maxWidth: .infinity, minHeight: MaskinSpace.s14 + MaskinSpace.s1)
				.submitLabel(.next)
				.onSubmit(addTopMatch)
				.onKeyPress(.delete) { backspace() }
				.onChange(of: query) { if !query.isEmpty { highlightedChip = nil } }
				#if os(iOS)
				.textInputAutocapitalization(.never)
				.autocorrectionDisabled()
				#endif
				.accessibilityLabel("To")
		}
		.padding(.vertical, MaskinSpace.s5)
		.padding(.leading, MaskinSpace.s8)
		.padding(.trailing, MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		.contentShape(RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
		.onTapGesture { toFocused.wrappedValue = true }
	}

	// MARK: People

	@ViewBuilder
	private var people: some View {
		if isSearching {
			sectionLabel(matches.isEmpty ? "No matches" : "\(matches.count) \(matches.count == 1 ? "match" : "matches")")
			if matches.isEmpty {
				Text("No one matches “\(query.trimmingCharacters(in: .whitespaces))”. Try a role, like Researcher or CPO.")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.padding(.horizontal, MaskinSpace.s2)
			} else {
				card(rows: matches)
			}
		} else if !matches.isEmpty {
			sectionLabel("Suggested")
			card(rows: matches)
		}
	}

	private func sectionLabel(_ text: String) -> some View {
		MonoLabel(text, color: MaskinColor.ink5)
			.padding(.top, MaskinSpace.s10)
			.padding(.bottom, MaskinSpace.s4)
			.padding(.horizontal, MaskinSpace.s2)
			.accessibilityAddTraits(.isHeader)
	}

	private func card(rows: [ChatActor]) -> some View {
		VStack(spacing: 0) {
			ForEach(Array(rows.enumerated()), id: \.element.id) { index, actor in
				Button { add(actor.id) } label: {
					HStack(spacing: MaskinSpace.s7) {
						ActorAvatar(
							name: actor.participant.name, kind: actor.participant.kind == .agent ? .agent : .human,
							size: MaskinSpace.s14 + MaskinSpace.s1, seed: actor.id, working: actor.agentState == .running)
						VStack(alignment: .leading, spacing: 1) {
							Text(actor.participant.name)
								.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold, relativeTo: .body))
								.foregroundStyle(MaskinColor.ink)
								.lineLimit(1)
							Text(NewConversationCopy.role(of: actor))
								.font(MaskinTypeface.sans(MaskinFontSize.t13, relativeTo: .footnote))
								.foregroundStyle(MaskinColor.ink5)
								.lineLimit(1)
						}
						Spacer(minLength: MaskinSpace.s4)
						Image(systemName: "plus")
							.maskinSymbol(MaskinFontSize.t14, weight: .bold)
							.foregroundStyle(MaskinColor.ink2)
							.frame(width: MaskinSpace.s14, height: MaskinSpace.s14)
							.background(MaskinSurface.fill, in: Circle())
							.accessibilityHidden(true)
					}
					.padding(.horizontal, MaskinSpace.s8)
					.padding(.vertical, MaskinSpace.s4)
					.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s7)
					.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.overlay(alignment: .top) { if index > 0 { Divider().overlay(MaskinSurface.separator) } }
				.accessibilityLabel("Add \(actor.participant.name), \(NewConversationCopy.role(of: actor))")
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadiusLarge.tile, style: .continuous))
	}

	// MARK: Actions

	private func add(_ id: String) {
		guard !draft.recipientIDs.contains(id) else { return }
		MaskinHaptics.play(.selection)
		withAnimation(MaskinMotion.quick) { draft.toggle(id) }
		query = ""
		highlightedChip = nil
		toFocused.wrappedValue = true
	}

	private func remove(_ id: String) {
		MaskinHaptics.play(.selection)
		withAnimation(MaskinMotion.quick) { draft.remove(id) }
		highlightedChip = nil
	}

	/// Return adds the top match, like a mail client's To field.
	private func addTopMatch() {
		if isSearching, let top = matches.first { add(top.id) } else { toFocused.wrappedValue = false }
	}

	/// Backspace on an empty field highlights the last chip; a second one removes it.
	private func backspace() -> KeyPress.Result {
		guard query.isEmpty, let last = draft.recipientIDs.last else { return .ignored }
		if highlightedChip == last {
			remove(last)
		} else {
			highlightedChip = last
		}
		return .handled
	}
}

/// A 34pt recipient chip: 26pt avatar, name, 30pt ✕.
private struct RecipientChip: View {
	let person: ChatParticipant
	var highlighted = false
	let onRemove: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s4 - 1) {
			ActorAvatar(
				name: person.name, kind: person.kind == .agent ? .agent : .human, size: MaskinSpace.s12 + MaskinSpace.s1,
				seed: person.id)
			Text(person.name)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .subheadline))
				.foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			Button(action: onRemove) {
				Image(systemName: "xmark")
					.maskinSymbol(MaskinFontSize.t11, weight: .heavy)
					.foregroundStyle(MaskinColor.ink4)
					.frame(width: MaskinSpace.s13 + MaskinSpace.s1, height: MaskinSpace.s13 + MaskinSpace.s1)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Remove \(person.name)")
		}
		.padding(.leading, MaskinSpace.s2)
		.padding(.trailing, MaskinSpace.s1)
		.frame(height: MaskinSpace.s14 + MaskinSpace.s1)
		.background(highlighted ? MaskinColor.sigTint : MaskinSurface.fill, in: Capsule())
		.animation(MaskinMotion.quick, value: highlighted)
	}
}

/// Rows of items that wrap, like text; the To field's chips and the starter chips.
struct FlowLayout: Layout {
	var spacing: CGFloat = MaskinSpace.s4
	var alignment: HorizontalAlignment = .leading

	func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
		let width = proposal.width ?? .infinity
		let rows = arrange(subviews, width: width)
		let height = rows.reduce(0) { $0 + $1.height } + spacing * CGFloat(max(0, rows.count - 1))
		return CGSize(width: proposal.width ?? rows.map(\.width).max() ?? 0, height: height)
	}

	func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
		var y = bounds.minY
		for row in arrange(subviews, width: bounds.width) {
			var x = alignment == .trailing ? bounds.maxX - row.width : bounds.minX
			for (index, size) in row.items {
				// A flexible item (the text field) takes what is left of its row.
				let width = row.stretchIndex == index ? max(size.width, bounds.maxX - x) : size.width
				subviews[index].place(
					at: CGPoint(x: x, y: y + (row.height - size.height) / 2), anchor: .topLeading,
					proposal: ProposedViewSize(width: width, height: size.height))
				x += width + spacing
			}
			y += row.height + spacing
		}
	}

	private struct Row {
		var items: [(Int, CGSize)] = []
		var width: CGFloat = 0
		var height: CGFloat = 0
		var stretchIndex: Int?
	}

	private func arrange(_ subviews: Subviews, width: CGFloat) -> [Row] {
		var rows: [Row] = [Row()]
		for (index, view) in subviews.enumerated() {
			let size = view.sizeThatFits(.unspecified)
			let stretches = view.sizeThatFits(.infinity).width > size.width + 1
			let needed = size.width + (rows[rows.count - 1].items.isEmpty ? 0 : spacing)
			if rows[rows.count - 1].width + needed > width, !rows[rows.count - 1].items.isEmpty {
				rows.append(Row())
			}
			var row = rows[rows.count - 1]
			row.items.append((index, size))
			row.width += size.width + (row.items.count > 1 ? spacing : 0)
			row.height = max(row.height, size.height)
			if stretches { row.stretchIndex = index }
			rows[rows.count - 1] = row
		}
		return rows
	}
}
