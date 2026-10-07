import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// One For You card. Stateless about the network: everything it shows arrives as values, every
/// gesture leaves as a closure, so it renders in a snapshot test exactly as on screen.
///
/// States, matching the mockup: the open ask (summary, options with their consequences,
/// inline reply), the receipt after a choice ("You chose X · Undo"), queued while offline (amber),
/// waiting on an agent after a typed reply, and a rolled-back failure.
struct DecisionCardView: View {
	struct Actions {
		var choose: (DecisionOption) -> Void = { _ in }
		var reply: (String) -> Void = { _ in }
		var undo: () -> Void = {}
		var dismiss: () -> Void = {}
		var retry: () -> Void = {}
		var open: (() -> Void)?
		var toggleExpanded: (() -> Void)?
	}

	let entry: FeedEntry
	let sender: String?
	let expanded: Bool
	var now: Date = Date()
	var actions = Actions()
	/// Where replies and quick questions go: the Chief of Staff. Without it (a card shown outside
	/// the feed) the card keeps its plain reply field, which comments on the object.
	var chief: ChiefOfStaffDesk?

	@State private var draft = ""
	@State private var composerFocused = false
	/// Present in the app; absent in previews and snapshots, where `@` falls back to `chief.suggestions`.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@FocusState private var replyFocused: Bool
	/// A destructive option waiting for its "Are you sure?" answer.
	@State private var pendingDestructive: DecisionOption?

	private var card: ForYouCard { entry.card }
	private var record: DecisionRecord? { entry.record }

	var body: some View {
		Group {
			if expanded || record != nil {
				fullCard
			} else {
				compactRow
			}
		}
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.hero + MaskinSpace.s3, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1)
		)
		.accessibilityElement(children: .contain)
	}

	// MARK: Compact (list mode)

	private var compactRow: some View {
		Button {
			actions.toggleExpanded?()
		} label: {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text(card.headline).maskinText(.headline).foregroundStyle(MaskinColor.ink)
						.lineLimit(2).multilineTextAlignment(.leading)
					HStack(spacing: MaskinSpace.s4) {
						if let status = card.status { StatusBadge(status, style: .word) }
						if let sender { Text(sender).maskinText(.caption).foregroundStyle(MaskinColor.ink4) }
						if let held = ForYouFormat.heldNote(since: card.latestActivityAt, now: now) {
							Text(held).maskinText(.caption).foregroundStyle(ForYouPalette.heldNote)
						}
					}
				}
				Spacer(minLength: MaskinSpace.s4)
				RelativeTime(card.latestActivityAt, style: .compact, compactDayLimit: 7)
					.maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
			}
			.padding(MaskinSpace.s9)
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityHint("Shows the full decision")
	}

	// MARK: Full

	private var fullCard: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			header
			say
			objectChip

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
					replyArea
				}
				.transition(.opacity)
			}
		}
		// The options fade into the receipt in place, and the card eases to its new height.
		.animation(MaskinMotion.standard, value: record.map { "\($0.phase)" })
		.padding(MaskinSpace.s9)
	}

	/// Every card speaks as the Chief of Staff, whichever agent escalated.
	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s4) {
			ChiefOfStaffTile()
			Text("Chief of Staff").maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				.lineLimit(1)
			Spacer(minLength: MaskinSpace.s3)
			if isWaiting {
				Text("WAITING")
					.maskinText(.microLabel)
					.foregroundStyle(ForYouPalette.waitingForeground)
					.padding(.horizontal, MaskinSpace.s3).padding(.vertical, MaskinSpace.s1)
					.background(ForYouPalette.waitingBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.btn - 2))
			} else if record == nil, let held = ForYouFormat.heldNote(since: card.latestActivityAt, now: now) {
				Text(held).maskinText(.caption).foregroundStyle(ForYouPalette.heldNote)
			}
			RelativeTime(card.latestActivityAt, style: .compact, compactDayLimit: 7)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel(sender.map { "Chief of Staff, for \($0)" } ?? "Chief of Staff")
	}

	private var asksQuestion: Bool {
		card.mention?.content.contains("?") == true
	}

	/// What the Chief of Staff says: the decision's summary, or the mention itself.
	@ViewBuilder private var say: some View {
		let content = VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			if let decision = card.decision {
				Text(decision.summary)
					.font(MaskinTypeface.sans(MaskinFontSize.t16))
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
			} else {
				Text(card.headline)
					.font(MaskinTypeface.sans(MaskinFontSize.t16, weight: .semibold))
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
				if !card.body.isEmpty { MarkdownContent(card.body) }
			}
		}
		.fixedSize(horizontal: false, vertical: true)
		if let toggle = actions.toggleExpanded {
			Button(action: toggle) { content }.buttonStyle(.plain)
		} else {
			content
		}
	}

	/// The object the card is about: an outlined chip that opens it.
	@ViewBuilder private var objectChip: some View {
		if let title = card.objectTitle, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
			Button {
				actions.open?()
			} label: {
				HStack(spacing: MaskinSpace.s5) {
					TypeBadge(card.objectType ?? "object", style: .tile)
					VStack(alignment: .leading, spacing: MaskinSpace.s1) {
						if let type = card.objectType { TypeBadge(type, style: .mono) }
						Text(title)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
							.foregroundStyle(MaskinColor.ink).lineLimit(1)
					}
					Spacer(minLength: MaskinSpace.s3)
					if actions.open != nil {
						Image(systemName: "chevron.right").font(.caption.weight(.semibold))
							.foregroundStyle(MaskinColor.ink5).accessibilityHidden(true)
					}
				}
				.padding(MaskinSpace.s5)
				.overlay(
					RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
						.strokeBorder(MaskinSurface.line, lineWidth: 1))
				.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(title)
			.accessibilityHint(actions.open == nil ? "" : "Opens \(title)")
		}
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
				.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold))
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
			ChipFlow(spacing: MaskinSpace.s4) {
				ForEach(decision.options) { option in
					Button {
						if option.destructive { pendingDestructive = option } else { actions.choose(option) }
					} label: {
						Text(option.label).multilineTextAlignment(.leading)
					}
					.buttonStyle(OptionPillStyle(recommended: option.recommended, destructive: option.destructive))
					.accessibilityLabel(option.recommended ? "\(option.label), recommended" : option.label)
					.accessibilityHint(option.consequences.joined(separator: ". "))
				}
			}
			if let line = Self.suggestedLine(for: decision) {
				Text(line).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.confirmationDialog(
			"Are you sure?", isPresented: Binding(
				get: { pendingDestructive != nil }, set: { if !$0 { pendingDestructive = nil } }),
			titleVisibility: .visible, presenting: pendingDestructive
		) { option in
			Button("Yes, \(option.label)", role: .destructive) { actions.choose(option) }
			Button("Cancel", role: .cancel) {}
		} message: { option in
			Text(
				(["\u{201C}\(option.label)\u{201D} can't be undone."] + option.consequences)
					.joined(separator: "\n"))
		}
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

	private var replyBar: some View {
		HStack(spacing: MaskinSpace.s4) {
			TextField(replyPrompt, text: $draft, axis: .vertical)
				.lineLimit(1...4)
				.maskinText(.body)
				.focused($replyFocused)
				.submitLabel(.send)
				.onSubmit(sendReply)
				.padding(.leading, MaskinSpace.s7)
				.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s2)
			Button(action: sendReply) {
				Image(systemName: "arrow.up")
					.font(.system(size: MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(width: MaskinSpace.touchMin - MaskinSpace.s2, height: MaskinSpace.touchMin - MaskinSpace.s2)
					.background(MaskinSurface.inverse, in: Circle())
					.opacity(canSend ? 1 : 0.3)
			}
			.buttonStyle(.plain)
			.disabled(!canSend)
			.accessibilityLabel("Send reply")
		}
		.padding(MaskinSpace.s2)
		.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
	}

	private var replyPrompt: String {
		let who = sender.map { "reply to \($0)" } ?? "reply"
		return card.decision == nil ? who.prefix(1).uppercased() + who.dropFirst() : "Or \(who)"
	}

	private var canSend: Bool { !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

	private func sendReply() {
		guard canSend else { return }
		actions.reply(draft)
		draft = ""
		replyFocused = false
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
				Image(systemName: "checkmark.circle.fill")
					.foregroundStyle(ForYouPalette.receiptCheck)
					.accessibilityHidden(true)
				Text(title).maskinText(.headline).foregroundStyle(ForYouPalette.receiptForeground)
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

	private func queuedNote(_ record: DecisionRecord) -> some View {
		let what: String
		switch record.kind {
		case .option(let label): what = "\u{201C}\(label)\u{201D}"
		case .reply: what = "Your reply"
		case .dismissed: what = "Your change"
		}
		return HStack(alignment: .top, spacing: MaskinSpace.s4) {
			Image(systemName: "arrow.up.circle.fill")
				.foregroundStyle(MaskinColor.warning)
				.accessibilityHidden(true)
			Text("\(what) is queued. It will send when you're back online.")
				.maskinText(.subhead).foregroundStyle(MaskinSurface.amberForeground)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.amberBackground, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous)
				.strokeBorder(MaskinSurface.amberBorder, lineWidth: 1)
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

/// The recommended option is the ink-gradient pill; the others are glass.
private struct OptionPillStyle: ButtonStyle {
	let recommended: Bool
	var destructive = false
	@Environment(\.isEnabled) private var isEnabled

	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold))
			.foregroundStyle(recommended ? Color.white : MaskinColor.ink)
			.padding(.horizontal, MaskinSpace.s8)
			.padding(.vertical, MaskinSpace.s5)
			.frame(minHeight: MaskinSpace.touchMin)
			.background(recommended ? AnyShapeStyle(MaskinGradient.decisionInk) : AnyShapeStyle(MaskinSurface.fill), in: Capsule())
			.shadow(color: recommended ? MaskinPatina.decisionShadow : .clear, radius: 8, y: 6)
			.overlay(
				Capsule().strokeBorder(destructive ? ForYouPalette.failureBorder : Color.clear, lineWidth: 1))
			.opacity(isEnabled ? 1 : 0.4)
			.scaleEffect(configuration.isPressed ? 0.97 : 1)
			.animation(MaskinMotion.quick, value: configuration.isPressed)
			.contentShape(Capsule())
	}
}

extension DecisionCardView.Actions {
	/// The gestures wired to a `ForYouStore`, with the same haptics, animation and VoiceOver
	/// announcements wherever the card appears (the feed, an object's detail).
	@MainActor
	static func live(
		store: ForYouStore, entry: FeedEntry, openObject: ((String) -> Void)?
	) -> Self {
		let card = entry.card
		func announce(_ text: String) { AccessibilityNotification.Announcement(text).post() }
		var actions = Self()
		actions.choose = { option in
			MaskinHaptics.play(.success)
			withAnimation(MaskinMotion.standard) { store.choose(option, on: card) }
			announce("You chose \(option.label). Undo is available for a few seconds.")
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
		}
		actions.retry = { store.decisions.clear(card.id) }
		if let open = openObject { actions.open = { open(card.id) } }
		return actions
	}
}
