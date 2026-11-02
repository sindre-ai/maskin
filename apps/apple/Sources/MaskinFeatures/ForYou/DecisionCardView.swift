import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

/// One For You card. Stateless about the network: everything it shows arrives as values, every
/// gesture leaves as a closure, so it renders in a snapshot test exactly as on screen.
///
/// States, matching the mockup: the open ask (summary, options with their consequences,
/// inline reply), the receipt after a choice ("You chose X · Undo"), queued while offline (notice),
/// waiting on an agent after a typed reply, and a rolled-back failure.
struct DecisionCardView: View {
	struct Actions {
		var choose: (DecisionOption) -> Void = { _ in }
		/// Sends or skips one message of a card that carries several. False: it could not be queued.
		var actOnDraft: (DecisionDraft, DecisionService.DraftAction) -> Bool = { _, _ in true }
		/// A hold with its optional reason ("Why are you holding it?"). Unset: holds go through `choose`.
		var hold: ((DecisionOption, String?) -> Void)?
		var reply: (String) -> Void = { _ in }
		var undo: () -> Void = {}
		var dismiss: () -> Void = {}
		var retry: () -> Void = {}
		var open: (() -> Void)?
		var expand: (() -> Void)?
		var collapse: (() -> Void)?
		/// Opens or closes the Later presets on the card (the Later pill, and a swipe left).
		var toggleLater: (() -> Void)?
		/// Picks a Later preset.
		var deferTo: ((LaterPreset) -> Void)?
		/// Opens the agent that did the work ("with Forge").
		var openAgent: (() -> Void)?
	}

	let entry: FeedEntry
	let sender: String?
	let expanded: Bool
	var now: Date = Date()
	var actions = Actions()
	/// Where replies and quick questions go: the Chief of Staff. Without it (a card shown outside
	/// the feed) the card keeps its plain reply field, which comments on the object.
	var chief: ChiefOfStaffDesk?
	/// iPad split view: the thread opens in the detail column, so an open thread never expands the card.
	var threadInDetail = false
	/// The agent that did the work, credited in the header next to the Chief of Staff.
	var agent: ForYouActor?
	/// The Later presets are open under the card's actions.
	var laterOpen = false
	/// Wide feed with a keyboard: the card takes focus and Return accepts its recommended option.
	var acceptsReturnKey = false
	@FocusState private var cardFocused: Bool
	/// The workspace's display name for an object type (never the raw key).
	var typeLabel: (String) -> String = { ForYouTypeLabel.label(for: $0) }
	/// A draft that is shown, ready to edit and approve, under Drafts to review: the card does not
	/// show it a second time and points there instead.
	var draftIsElsewhere: (DecisionDraft) -> Bool = { _ in false }
	/// Set while a message of this card has an edit that has not gone out: the options that would
	/// send the saved text are off, and this says why.
	var unsentEditNote: String?

	@State private var fallbackComposer = ChatComposerModel(uploader: nil, selfActorID: "")
	@State private var composerFocused = false
	/// Present in the app; absent in previews and snapshots, where `@` falls back to `chief.suggestions`.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	/// A destructive option waiting for its "Are you sure?" answer.
	@State private var pendingDestructive: DecisionOption?
	/// A hold waiting for its reason (or Skip).
	@State private var pendingHold: DecisionOption?

	private var card: ForYouCard { entry.card }
	private var record: DecisionRecord? { entry.record }

	/// Opened by the reader (Ask); a card also stays open while its reply is being worked on.
	private var engagement: CardExpansion.Engagement {
		CardExpansion.Engagement(
			composerFocused: composerFocused,
			hasDraft: chief.map { !$0.composer(for: card).text.isEmpty } ?? !fallbackComposer.text.isEmpty,
			threadOpen: !threadInDetail && chief?.presented?.card.id == card.id)
	}

	/// Text typed into the reply is kept when the card folds; the folded card says so.
	private var hasReplyDraft: Bool {
		chief.map { !$0.composer(for: card).text.isEmpty } ?? !fallbackComposer.text.isEmpty
	}

	private var isExpanded: Bool {
		CardExpansion.isExpanded(manual: expanded, engagement: engagement)
	}

	var body: some View {
		fullCard
			.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.brief, style: .continuous))
			.sheet(item: $pendingHold) { option in
				HoldReasonSheet(agent: sender) { reason in actions.hold?(option, reason) }
			}
			.accessibilityElement(children: .contain)
			.modifier(ReturnKeyAccept(enabled: acceptsReturnKey && record == nil, focus: $cardFocused) {
				returnKey()
			})
	}

	/// What Return does on a focused card (4-iPad.md: "accepts the recommended option, confirm sheet
	/// still shown where it confirms").
	enum ReturnKeyAction: Equatable {
		case choose, confirmFirst, askReason, nothing

		static func resolve(for decision: DecisionPrompt?) -> (ReturnKeyAction, DecisionOption?) {
			guard let option = decision?.recommended else { return (.nothing, nil) }
			if option.destructive { return (.confirmFirst, option) }
			if HoldReason.isHold(option.label) { return (.askReason, option) }
			return (.choose, option)
		}
	}

	private func returnKey() {
		let (action, option) = ReturnKeyAction.resolve(for: card.decision)
		guard let option else { return }
		if isHeldBack(option) { return }
		switch action {
		case .choose: actions.choose(option)
		case .confirmFirst: pendingDestructive = option
		case .askReason:
			if actions.hold != nil { pendingHold = option } else { actions.choose(option) }
		case .nothing: break
		}
	}

	// MARK: Full

	private var fullCard: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				header
				statusChips
			}
			say
			if let draft = card.decision?.draft, !draftIsElsewhere(draft) { DraftPreview(draft: draft) }
			if let drafts = card.decision?.drafts.filter({ !draftIsElsewhere($0) }), !drafts.isEmpty {
				DraftStackView(drafts: drafts, act: actions.actOnDraft, allDone: actions.dismiss)
			}
			if hasDraftElsewhere {
				Text("Read and edit the message under Drafts to review.")
					.font(MaskinTypeface.sans(MaskinFontSize.t13))
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity, alignment: .leading)
			}

			if let record, !isFailed(record) {
				receipt(record).transition(.opacity)
			} else {
				Group {
					if let failure = failureMessage { failureBanner(failure) }
					if let decision = card.decision {
						ask(decision)
					} else {
						noDecisionRow
					}
					if isExpanded {
						replyArea
						showLess
					} else {
						footer
					}
				}
				.transition(.opacity)
			}
		}
		// The options fade into the receipt in place, and the card eases to its new height.
		.animation(MaskinMotion.standard, value: record.map { "\($0.phase)" })
		.animation(MaskinMotion.standard, value: isExpanded)
		.padding(.horizontal, MaskinSpace.s10)
		.padding(.top, MaskinSpace.s9)
		.padding(.bottom, MaskinSpace.s9)
	}

	private var hasDraftElsewhere: Bool {
		guard let decision = card.decision else { return false }
		return ((decision.draft.map { [$0] } ?? []) + decision.drafts).contains(where: draftIsElsewhere)
	}

	/// Who is speaking: the agent that did the work, else the Chief of Staff.
	private var whoName: String { agent?.name ?? "Chief of Staff" }

	/// v6 header: a tile for who is speaking, their name over the object the card is about (a link
	/// to it, with the type's dot), and one chat button that opens the Chief of Staff thread.
	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s5) {
			ActorAvatar(name: whoName, kind: .agent, size: 36)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(whoName)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
					.tracking(-0.15)
					.foregroundStyle(MaskinColor.ink)
					.lineLimit(1)
				objectLine
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			discussButton
		}
	}

	/// The object the card is about, under the speaker's name. Opens it.
	@ViewBuilder private var objectLine: some View {
		if let title = card.objectTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !title.isEmpty {
			Button {
				actions.open?()
			} label: {
				HStack(spacing: MaskinSpace.s3) {
					if let type = card.objectType {
						// The type's hue is the one documented colour exception in this card.
						RoundedRectangle(cornerRadius: MaskinRadius.tag2, style: .continuous)
							.fill(MaskinObjectType.dotColor(for: type))
							.frame(width: 7, height: 7)
							.accessibilityHidden(true)
					}
					Text(title)
						.font(MaskinTypeface.sans(MaskinFontSize.t12))
						.foregroundStyle(MaskinColor.ink4)
						.lineLimit(1)
				}
				// A 44pt target around a 16pt row, pulled back so the header stays slim.
				.padding(.vertical, (MaskinSpace.touchMin - 16) / 2)
				.contentShape(Rectangle())
				.padding(.vertical, -(MaskinSpace.touchMin - 16) / 2)
			}
			.buttonStyle(.maskinPressed)
			.disabled(actions.open == nil)
			.accessibilityLabel(title)
			.accessibilityHint(actions.open == nil ? "" : "Opens \(title)")
		}
	}

	/// The chat bubble that was the Discuss pill: a 40pt circle in a 44pt target.
	@ViewBuilder private var discussButton: some View {
		if actions.expand != nil {
			Button {
				actions.expand?()
			} label: {
				Image(systemName: "bubble.left")
					.maskinSymbol(17, weight: .semibold)
					.foregroundStyle(MaskinColor.ink)
					.frame(width: 40, height: 40)
					.background(MaskinSurface.fill, in: Circle())
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.contentShape(Circle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("Discuss with Chief of Staff")
		}
	}

	/// The one chip: why it is here. Blocking and due are the signal colour, a plain wait is neutral.
	@ViewBuilder private var statusChips: some View {
		if isWaiting || entry.urgency != nil || entry.backFromLater {
			HStack(spacing: MaskinSpace.s3) {
				if entry.backFromLater { chip("Back again", hot: false, dot: false) }
				if isWaiting {
					chip("Waiting for \(agent?.name ?? sender ?? "an agent")", hot: false, dot: true)
				} else if let urgency = entry.urgency {
					chip(urgency.text, hot: urgency.isHot, dot: true)
				}
			}
		}
	}

	private func chip(_ text: String, hot: Bool, dot: Bool) -> some View {
		HStack(spacing: MaskinSpace.s3) {
			if dot { Circle().fill(Color.primary).frame(width: 6, height: 6).accessibilityHidden(true) }
			Text(text).font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
		}
		.foregroundStyle(hot ? ForYouPalette.waitingForeground : MaskinColor.ink3)
		.padding(.horizontal, MaskinSpace.s5)
		.frame(height: 26)
		.background(hot ? ForYouPalette.waitingBackground : MaskinSurface.fill, in: Capsule())
		.accessibilityElement(children: .combine)
	}

	private var asksQuestion: Bool {
		card.mention?.content.contains("?") == true
	}

	/// What the Chief of Staff says: the decision's summary, or the mention itself. The card's own
	/// object name inside the text is an underlined link that opens it.
	@ViewBuilder private var say: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			if let decision = card.decision {
				messageText(decision.summary)
			} else {
				Text(card.headline)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold))
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
				if !card.body.isEmpty { MarkdownContent(card.body).environment(\.markdownCards, false) }
			}
		}
		.fixedSize(horizontal: false, vertical: true)
	}

	private static let objectScheme = "maskin-object"

	private func messageText(_ text: String) -> some View {
		var attributed = AttributedString(text)
		for range in ObjectLinks.ranges(of: card.objectTitle, in: text) {
			guard let lower = AttributedString.Index(range.lowerBound, within: attributed),
				let upper = AttributedString.Index(range.upperBound, within: attributed)
			else { continue }
			attributed[lower..<upper].underlineStyle = .single
			#if canImport(UIKit)
			attributed[lower..<upper].uiKit.underlineColor = UIColor(MaskinColor.sigHi)
			#endif
			if actions.open != nil {
				attributed[lower..<upper].link = URL(string: "\(Self.objectScheme)://open")
			}
		}
		return Text(attributed)
			.font(MaskinTypeface.sans(MaskinFontSize.t16))
			.tracking(-0.16)
			.lineSpacing(MaskinSpace.s2)
			.foregroundStyle(MaskinColor.ink)
			.tint(MaskinColor.ink)
			.frame(maxWidth: .infinity, alignment: .leading)
			.environment(
				\.openURL,
				OpenURLAction { url in
					guard url.scheme == Self.objectScheme, let open = actions.open else { return .systemAction }
					open()
					return .handled
				})
	}

	/// A plain mention has no options: say so, and make "I've seen it" one tap.
	private var noDecisionRow: some View {
		HStack(spacing: MaskinSpace.s4) {
			Text(asksQuestion ? "Needs you" : "Just a heads-up").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Spacer(minLength: MaskinSpace.s3)
			Button("Mark read", action: actions.dismiss)
				.maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				.frame(minHeight: MaskinSpace.touchMin)
		}
	}

	// MARK: Ask

	/// The ask continues the message: the question, then one pill per option, then the agent's
	/// own reasoning for its suggestion in a quiet line.
	private func ask(_ decision: DecisionPrompt) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			Text(decision.ask)
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
				.tracking(-0.15)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
			// v6: the recommended option is a full-width ink button; the rest share one row beneath.
			ForEach(primaryOptions(of: decision)) { option in optionButton(option) }
			let others = alternateOptions(of: decision)
			if !others.isEmpty {
				if others.count <= 3 {
					HStack(spacing: MaskinSpace.s4) {
						ForEach(others) { option in optionButton(option) }
					}
				} else {
					ChipFlow(spacing: MaskinSpace.s4) {
						ForEach(others) { option in optionButton(option) }
					}
				}
			}
			if let note = unsentEditNote {
				Text(note)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
					.foregroundStyle(ForYouPalette.waitingForeground)
					.frame(maxWidth: .infinity, alignment: .leading)
					.fixedSize(horizontal: false, vertical: true)
			}
			if isExpanded, let line = Self.suggestedLine(for: decision) {
				Text(line).font(MaskinTypeface.sans(MaskinFontSize.t13)).foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.sheet(item: $pendingHold) { option in
			HoldReasonSheet(agent: sender) { reason in actions.hold?(option, reason) }
		}
		.sheet(item: $pendingDestructive) { option in
			ConfirmOptionSheet(option: option) { actions.choose(option) }
		}
	}

	private func primaryOptions(of decision: DecisionPrompt) -> [DecisionOption] {
		decision.options.filter(\.recommended)
	}

	private func alternateOptions(of decision: DecisionPrompt) -> [DecisionOption] {
		decision.options.filter { !$0.recommended }
	}

	private func optionButton(_ option: DecisionOption) -> some View {
		Button {
			if option.destructive {
				pendingDestructive = option
			} else if actions.hold != nil, HoldReason.isHold(option.label) {
				pendingHold = option
			} else {
				actions.choose(option)
			}
		} label: {
			OptionPill(
				label: pendingDestructive == option ? option.label + "\u{2026}" : option.label,
				recommended: option.recommended, destructive: option.destructive)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.maskinHover(.fill, cornerRadius: MaskinRadius.card2xl)
		.disabled(isHeldBack(option))
		.accessibilityLabel(option.recommended ? "\(option.label), recommended" : option.label)
		.accessibilityHint(
			isHeldBack(option) ? (unsentEditNote ?? "") : option.consequences.joined(separator: ". "))
	}

	/// The option would send the saved text while the reader's edit has not gone out.
	private func isHeldBack(_ option: DecisionOption) -> Bool {
		unsentEditNote != nil && ReviewDraft.sendsMessage(option)
	}

	/// "Suggested: 7-day window. Ships with cycle 1 tomorrow. Adds 18 support tickets."
	static func suggestedLine(for decision: DecisionPrompt) -> String? {
		guard let option = decision.recommended else { return nil }
		let reasons = option.consequences.prefix(2).map { line -> String in
			let trimmed = line.trimmingCharacters(in: .whitespaces)
			return trimmed.hasSuffix(".") ? trimmed : trimmed + "."
		}
		return (["Suggested: \(option.label)."] + reasons).joined(separator: " ")
	}

	// MARK: Footer

	/// Compact card footer. The object link and Discuss moved up into the header (v6); what is left
	/// is Later, which on a phone is a swipe, so its pill only shows on the wide feed (no swipe
	/// rows there) and a kept reply draft is still flagged.
	@ViewBuilder private var footer: some View {
		if acceptsReturnKey || hasReplyDraft || laterOpen {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if acceptsReturnKey || hasReplyDraft {
					HStack(spacing: MaskinSpace.s4) {
						Spacer(minLength: 0)
						if hasReplyDraft {
							Text("Draft kept").maskinText(.caption).foregroundStyle(ForYouPalette.waitingForeground)
								.accessibilityLabel("Reply draft kept")
						}
						if acceptsReturnKey { laterPill }
					}
				}
				if laterOpen { laterPresets }
			}
		}
	}

	/// 40pt pill inside a 44pt target.
	private func pill(
		_ title: String, symbol: String? = nil, selected: Bool = false, action: @escaping () -> Void
	) -> some View {
		Button(action: action) {
			HStack(spacing: MaskinSpace.s3) {
				if let symbol {
					Image(systemName: symbol).maskinSymbol(MaskinFontSize.t13, weight: .semibold)
						.accessibilityHidden(true)
				}
				Text(title).font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold))
			}
			.foregroundStyle(selected ? MaskinSurface.onInverse : MaskinColor.ink2)
			.padding(.horizontal, MaskinSpace.s8)
			.frame(height: 40)
			.background(selected ? MaskinSurface.inverse : MaskinSurface.fill, in: Capsule())
			.frame(minHeight: MaskinSpace.touchMin)
			.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
	}

	@ViewBuilder private var laterPill: some View {
		if actions.toggleLater != nil {
			pill("Later", symbol: "clock", selected: laterOpen) { actions.toggleLater?() }
				.accessibilityHint("Choose when this comes back")
		}
	}

	/// The presets under the card's actions, and Hold for when the reason matters.
	private var laterPresets: some View {
		ChipFlow(spacing: MaskinSpace.s4) {
			ForEach(LaterPreset.allCases, id: \.self) { preset in
				laterChip(preset.label) { actions.deferTo?(preset) }
			}
			if actions.hold != nil {
				laterChip("Not yet, and why\u{2026}", outlined: true) {
					pendingHold = holdOption
				}
			}
		}
		.transition(.opacity)
	}

	private func laterChip(_ title: String, outlined: Bool = false, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Text(title)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				.foregroundStyle(MaskinColor.ink2)
				.padding(.horizontal, MaskinSpace.s9 - 1)
				.frame(height: 40)
				.background(outlined ? Color.clear : MaskinSurface.fill, in: Capsule())
				.overlay(Capsule().strokeBorder(outlined ? MaskinSurface.line : Color.clear, lineWidth: 1))
				.frame(minHeight: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed(.shrink))
	}

	/// The card's own Hold option when the agent wrote one, else a plain "Hold".
	private var holdOption: DecisionOption {
		card.decision?.options.first(where: { HoldReason.isHold($0.label) })
			?? DecisionOption(label: "Hold")
	}

	/// Folds an opened card. The reply text stays in the composer model, so nothing is lost.
	@ViewBuilder private var showLess: some View {
		VStack(spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s3) {
				laterPill
				if actions.collapse != nil, expanded, !engagement.isEngaged {
					Button {
						actions.collapse?()
					} label: {
						Text("Show less")
							.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.semibold))
							.foregroundStyle(MaskinColor.ink5)
							.padding(.horizontal, MaskinSpace.s8)
							.frame(minHeight: MaskinSpace.touchMin)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
				}
			}
			.frame(maxWidth: .infinity)
			if laterOpen { laterPresets }
		}
	}

	// MARK: Reply

	/// The chat composer, with the card's quick questions above it while it is focused.
	@ViewBuilder private var replyArea: some View {
		if let chief {
			let model = chief.composer(for: card)
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				if composerFocused, MentionTrigger.find(in: model.text) == nil {
					QuickQuestionChips(questions: ForYouQuickQuestions.chips(for: card)) { question in
						Task { await chief.ask(question, card: card) }
					}
					.transition(.opacity)
				}
				ChatComposer(
					model: model, placeholder: "Message Chief of Staff",
					suggestions: { chief.suggestions(for: $0, excluding: Set(model.mentions.map(\.id))) },
					inConversation: [], onSend: { Task { await chief.submit(card: card) } },
					agentName: "Chief of Staff", roster: runtime?.mentionRoster()?.roster,
					allowsLive: false, onFocusChange: { composerFocused = $0 })
			}
			.animation(MaskinMotion.quick, value: composerFocused)
			.task { await runtime?.mentionRoster()?.load() }
		} else {
			replyBar
		}
	}

	/// The reply bar when there is no Chief of Staff to route to: the shared composer, inline.
	private var replyBar: some View {
		MaskinComposer(
			model: fallbackComposer,
			config: MaskinComposerConfig(
				variant: .inline, placeholder: replyPrompt, showsAttach: false, showsMic: false,
				onFocusChange: { composerFocused = $0 }),
			onSend: sendReply)
	}

	private var replyPrompt: String {
		let who = sender.map { "reply to \($0)" } ?? "reply"
		return card.decision == nil ? who.prefix(1).uppercased() + who.dropFirst() : "Or \(who)"
	}

	private func sendReply() {
		let text = fallbackComposer.trimmedText
		guard !text.isEmpty else { return }
		actions.reply(text)
		fallbackComposer.clear()
	}

	// MARK: Receipts

	private var isWaiting: Bool {
		if let record, case .reply = record.kind, !isFailed(record) { return true }
		return false
	}

	private func isFailed(_ record: DecisionRecord) -> Bool {
		if case .failed = record.phase { return true }
		return false
	}

	private var failureMessage: String? {
		if let record, case .failed(let message) = record.phase { return message }
		return nil
	}

	@ViewBuilder
	private func receipt(_ record: DecisionRecord) -> some View {
		switch record.phase {
		case .queued:
			queuedNote(record)
		case .held, .sending, .sent:
			doneReceipt(record)
		case .failed:
			EmptyView()
		}
	}

	private func doneReceipt(_ record: DecisionRecord) -> some View {
		let title: String
		switch record.kind {
		case .option(let label): title = "You chose \(label)"
		case .reply: title = sender.map { "Reply sent to \($0)" } ?? "Reply sent"
		case .dismissed: title = "Marked as read"
		}
		let sending: Bool = {
			if case .sending = record.phase { return true }
			return false
		}()
		let consequences: [String] = {
			guard case .option(let label) = record.kind else { return [] }
			return card.decision?.options.first(where: { $0.label == label })?.consequences ?? []
		}()
		return VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.s4) {
				Image(systemName: "checkmark")
					.maskinSymbol(MaskinFontSize.t12, weight: .bold)
					.foregroundStyle(ForYouPalette.receiptBackground)
					.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
					.background(ForYouPalette.receiptCheck, in: Circle())
					.accessibilityHidden(true)
				Text(title)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: MaskinFontWeight.w650))
					.foregroundStyle(ForYouPalette.receiptForeground)
					.frame(maxWidth: .infinity, alignment: .leading)
				if sending {
					ProgressView().controlSize(.small)
				} else if canUndo(record) {
					Button("Undo", action: actions.undo)
						.maskinText(.subhead).fontWeight(.semibold)
						.foregroundStyle(ForYouPalette.receiptForeground)
						.frame(minHeight: MaskinSpace.touchMin)
						.accessibilityHint("Takes the decision back before it is sent")
				}
			}
			if !consequences.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					ForEach(consequences, id: \.self) {
						Text($0).maskinText(.subhead).foregroundStyle(ForYouPalette.receiptSecondary)
					}
				}
				.padding(.leading, MaskinSpace.s12 + MaskinSpace.s1)
			}
			if case .option(let label) = record.kind, HoldReason.isHold(label),
				let reason = HoldReason.normalized(record.note)
			{
				Text(HoldReason.note(for: reason))
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.frame(maxWidth: .infinity, alignment: .leading)
					.padding(MaskinSpace.s6)
					.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
					.padding(.leading, MaskinSpace.s12 + MaskinSpace.s1)
			}
			if record.staysUnread, case .sent = record.phase {
				Text("Sent, but this thread will stay in your feed.")
					.maskinText(.caption).foregroundStyle(ForYouPalette.receiptTertiary)
					.padding(.leading, MaskinSpace.s12 + MaskinSpace.s1)
			}
		}
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.receiptBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(ForYouPalette.receiptBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
		.accessibilityAction(named: "Undo") { if canUndo(record) { actions.undo() } }
	}

	private func canUndo(_ record: DecisionRecord) -> Bool {
		if case .held = record.phase { return true }
		if case .dismissed = record.kind, case .sent = record.phase { return true }
		return false
	}

	/// "Queued offline — Approve sends when you're back."
	static func queuedText(_ record: DecisionRecord) -> String {
		var label = ""
		switch record.kind {
		case .option(let option): label = option
		case .reply: label = "Your reply"
		case .dismissed: label = "Mark read"
		}
		return "Queued offline \u{2014} \(label) sends when you\u{2019}re back."
	}

	private func queuedNote(_ record: DecisionRecord) -> some View {
		HStack(alignment: .center, spacing: MaskinSpace.s4) {
			Image(systemName: "arrow.up")
				.maskinSymbol(MaskinFontSize.t12, weight: .bold)
				.foregroundStyle(MaskinSurface.onInverse)
				.frame(width: MaskinSpace.s12, height: MaskinSpace.s12)
				.background(MaskinSurface.inverse, in: Circle())
				.accessibilityHidden(true)
			Text(Self.queuedText(record))
				.maskinText(.subhead).foregroundStyle(MaskinColor.noticeFg)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(MaskinSpace.s7)
		.background(MaskinColor.noticeBg, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous)
				.strokeBorder(MaskinColor.noticeBd, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}

	private func failureBanner(_ message: String) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "exclamationmark.triangle.fill")
				.foregroundStyle(ForYouPalette.failureForeground)
				.accessibilityHidden(true)
			VStack(alignment: .leading, spacing: MaskinSpace.s2) {
				Text("Couldn't send that. It's back in your feed.")
					.maskinText(.subhead).fontWeight(.semibold)
				Text(message).maskinText(.caption)
			}
			.foregroundStyle(ForYouPalette.failureForeground)
			Spacer(minLength: 0)
			Button("OK", action: actions.retry)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(ForYouPalette.failureForeground)
				.frame(minHeight: MaskinSpace.touchMin)
		}
		.padding(MaskinSpace.s7)
		.background(ForYouPalette.failureBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(ForYouPalette.failureBorder, lineWidth: 1)
		)
		.accessibilityElement(children: .combine)
	}
}

// MARK: - Option pill

/// v6 option buttons. The recommended one is a full-width ink-gradient button with a mono
/// "Suggested" tag; the others are equal-width glass pills in one row. Pressing is the shared
/// `.maskinPressed(.shrink)` on the button around it.
private struct OptionPill: View {
	let label: String
	let recommended: Bool
	var destructive = false
	@Environment(\.isEnabled) private var isEnabled

	var body: some View {
		if recommended {
			let shape = RoundedRectangle(cornerRadius: MaskinRadius.card2xl - 2, style: .continuous)
			HStack(spacing: MaskinSpace.s5) {
				Text(label)
					.multilineTextAlignment(.leading)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .bold))
				Spacer(minLength: 0)
				Text("Suggested")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold))
					.opacity(0.7)
			}
			.foregroundStyle(MaskinPatina.decisionInkText)
			.padding(.horizontal, MaskinSpace.s10)
			.padding(.vertical, MaskinSpace.s5)
			.frame(maxWidth: .infinity, minHeight: 54)
			.background(AnyShapeStyle(MaskinGradient.decisionInk), in: shape)
			.shadow(color: MaskinPatina.decisionShadow, radius: 8, y: 6)
			.overlay(shape.strokeBorder(destructive ? ForYouPalette.failureBorder : Color.clear, lineWidth: 1))
			.opacity(isEnabled ? 1 : 0.4)
			.contentShape(shape)
		} else {
			let shape = RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
			Text(label)
				.multilineTextAlignment(.center)
				.fixedSize(horizontal: false, vertical: true)
				.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
				.foregroundStyle(MaskinColor.ink)
				.padding(.horizontal, MaskinSpace.s5)
				.padding(.vertical, MaskinSpace.s3)
				.frame(maxWidth: .infinity, minHeight: 46)
				.background(MaskinSurface.fill, in: shape)
				.overlay(shape.strokeBorder(destructive ? ForYouPalette.failureBorder : Color.clear, lineWidth: 1))
				.opacity(isEnabled ? 1 : 0.4)
				.contentShape(shape)
		}
	}
}

extension DecisionCardView.Actions {
	/// Offers the Undo toast: a message and what Undo does. Nil in snapshots and the object sheet.
	typealias OfferUndo = @MainActor (String, @escaping @MainActor () async -> Void) -> Void

	/// The gestures wired to a `ForYouStore`, with the same haptics, animation and VoiceOver
	/// announcements wherever the card appears (the feed, an object's detail). A decision commits
	/// the instant it is tapped (haptic and state in the same frame) and the card leaves the open
	/// list; Undo is on the toast and on its HANDLED TODAY row until it is sent.
	@MainActor
	static func live(
		store: ForYouStore, entry: FeedEntry, openObject: ((String) -> Void)?,
		offerUndo: OfferUndo? = nil
	) -> Self {
		let card = entry.card
		let agent = store.agent(of: card)?.name ?? store.senderName(of: card)
		func announce(_ text: String) { AccessibilityNotification.Announcement(text).post() }
		func receipt(_ label: String) -> String {
			agent.map { "\(label) \u{00B7} \($0) carries on." } ?? "\(label) \u{00B7} sent."
		}
		var actions = Self()
		actions.choose = { option in
			MaskinHaptics.play(.success)
			withAnimation(MaskinMotion.standard) { store.choose(option, on: card) }
			announce("You chose \(option.label). Undo is available for a few seconds.")
			offerUndo?(receipt(option.label)) { withAnimation(MaskinMotion.standard) { _ = store.undo(card) } }
		}
		actions.actOnDraft = { draft, action in
			let queued = store.actOnDraft(draft, action: action, on: card)
			if queued {
				MaskinHaptics.play(.success)
				announce(action == .send ? "Told the agent to send it." : "Skipped.")
			}
			return queued
		}
		actions.hold = { option, reason in
			MaskinHaptics.play(.success)
			withAnimation(MaskinMotion.standard) { store.choose(option, note: reason, on: card) }
			announce("You chose \(option.label). Undo is available for a few seconds.")
			offerUndo?(receipt(option.label)) { withAnimation(MaskinMotion.standard) { _ = store.undo(card) } }
		}
		actions.reply = { text in
			MaskinHaptics.play(.light)
			withAnimation(MaskinMotion.standard) { store.reply(text, on: card) }
			announce("Reply sent.")
		}
		actions.undo = {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.standard) { _ = store.undo(card) }
		}
		actions.dismiss = {
			MaskinHaptics.play(.selection)
			withAnimation(MaskinMotion.standard) { store.dismiss(card) }
			offerUndo?("Marked read \u{2014} it stays on the timeline.") {
				withAnimation(MaskinMotion.standard) { _ = store.undo(card) }
			}
		}
		actions.deferTo = { preset in
			MaskinHaptics.play(.light)
			let previous = withAnimation(MaskinMotion.standard) { store.deferCard(card, to: preset) }
			announce("Later, \(preset.label).")
			offerUndo?("Later \u{00B7} \(preset.label).") {
				withAnimation(MaskinMotion.standard) { store.undoLater(card, restoring: previous) }
			}
		}
		actions.retry = { store.decisions.clear(card.id) }
		if let open = openObject { actions.open = { open(card.id) } }
		return actions
	}
}


/// Makes a card keyboard focusable and maps Return to `action`. A no-op when disabled, and below
/// iOS 17 / macOS 14 there is no `onKeyPress`, so it does nothing there either.
private struct ReturnKeyAccept: ViewModifier {
	let enabled: Bool
	var focus: FocusState<Bool>.Binding
	let action: () -> Void

	func body(content: Content) -> some View {
		if enabled {
			content
				.focusable()
				.focused(focus)
				.onKeyPress(.return) {
					action()
					return .handled
				}
		} else {
			content
		}
	}
}
