import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI
import WatchKit

/// Decisions waiting on the wearer, one card per page. A page holds the ask, why, the recommended
/// option and Hold / More, all without scrolling; "More" lists every option the iPhone card has.
/// One tap decides (optimistic, held for the Undo window); one that can't be taken back asks
/// first, and Hold asks why. When the watch can't reach the feed, the last snapshot (from the
/// phone or its own last read) is shown read-only. Pushed from Home, inside its navigation stack.
struct WatchNeedsYou: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	let workspaceId: String?

	@State private var selection: String?
	/// "Done" on the last receipt: the wearer is finished, so show Caught up rather than the receipts.
	@State private var finished = false

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	var body: some View {
		content
			.toolbar(.hidden, for: .navigationBar)
			.containerBackground(for: .navigation) { WatchBackdrop() }
			// A new decision arriving after Done ends the caught-up screen.
				.onChange(of: entries.contains { $0.record == nil }) { _, hasOpen in
				if hasOpen { finished = false }
			}
	}

	/// "Done" on the last receipt: back to a decision still open, else Caught up.
	private func finish() {
		if let open = entries.first(where: { $0.record == nil }) {
			selection = open.id
		} else {
			finished = true
		}
	}

	@ViewBuilder
	private var content: some View {
		if finished, store != nil {
			WatchCaughtUp()
		} else if let store, !entries.isEmpty {
			TabView(selection: $selection) {
				ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
					WatchDecisionPage(
						store: store, entry: entry, workspaceId: workspaceId,
						position: WatchDecisionOptions.position(index, of: entries.count),
						next: index + 1 < entries.count ? { selection = entries[index + 1].id } : nil,
						finish: finish)
					.tag(Optional(entry.id))
				}
			}
			.tabViewStyle(.page)
		} else if !watch.cards.isEmpty, store?.isEmpty != true {
			// Offline or still loading: the last known state, read only.
			TabView {
				ForEach(Array(watch.cards.enumerated()), id: \.element.id) { index, card in
					WatchSnapshotPage(
						card: card, position: WatchDecisionOptions.position(index, of: watch.cards.count),
						updatedAt: watch.snapshot?.updatedAt, offline: watch.isOffline)
				}
			}
			.tabViewStyle(.page)
		} else if let store, store.phase == .loading, store.cards.isEmpty {
			WatchSpinner()
		} else if let store, case .failed(let message) = store.phase, store.cards.isEmpty {
			EmptyState(symbol: "exclamationmark.circle", title: "Can't load", message: message, style: .circled) {
				Button("Retry") { Task { await store.load() } }
					.frame(minHeight: WatchMetrics.target)
			}
		} else {
			WatchCaughtUp()
		}
	}
}

/// Nothing waits on the wearer.
private struct WatchCaughtUp: View {
	var body: some View {
		VStack(spacing: MaskinSpace.gapLoose) {
			Image(systemName: "checkmark.circle")
				.font(.system(size: MaskinFontSize.t26, weight: .regular))
				.foregroundStyle(MaskinColor.sigHi)
				.accessibilityHidden(true)
			Text("You're caught up").font(WatchType.action()).foregroundStyle(MaskinColor.ink)
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
	}
}

/// Tile, sender and where this page sits in the pager ("1 of 3").
private struct WatchDecisionHeader: View {
	let sender: String
	let position: String

	var body: some View {
		HStack(spacing: MaskinSpace.gapDefault) {
			WatchTile(name: sender)
			Text(sender).font(WatchType.name()).foregroundStyle(MaskinColor.ink).lineLimit(1)
			Spacer(minLength: 0)
			Text(position).font(WatchType.mono()).foregroundStyle(MaskinColor.ink4)
		}
	}
}

/// One decision. Also pushed from a flow's "Review decision", where there is no pager (`next` nil).
struct WatchDecisionPage: View {
	let store: ForYouStore
	let entry: FeedEntry
	let workspaceId: String?
	/// "1 of 3".
	let position: String
	/// Moves the pager to the next decision; nil on the last one.
	let next: (() -> Void)?
	/// "Done" on the last receipt.
	var finish: () -> Void = {}

	private enum Route: Hashable {
		/// The label of the option being confirmed (an option's id).
		case confirm(String)
		case hold(String)
		case all
	}

	@State private var route: Route?
	@Environment(\.dismiss) private var dismiss

	private var card: ForYouCard { entry.card }
	private var options: [DecisionOption] { WatchDecisionOptions.all(card.decision?.options ?? []) }
	private func option(labelled label: String) -> DecisionOption? { options.first { $0.id == label } }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if let record = entry.record, !isFailed(record) {
					receipt(record)
				} else {
					decision
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s1)
		}
		// "Open on iPhone": the phone picks up this card from the app switcher.
		.userActivity(HandoffActivity.type, isActive: workspaceId != nil) { activity in
			guard let workspaceId else { return }
			activity.isEligibleForHandoff = true
			activity.title = card.headline
			activity.userInfo = HandoffActivity.userInfo(workspaceId: workspaceId, objectId: card.id)
		}
		.navigationDestination(item: $route) { route in
			switch route {
			case .confirm(let label):
				if let option = option(labelled: label) {
					WatchConfirm(option: option) {
						decide(option)
						self.route = nil
					} cancel: {
						self.route = nil
					}
				}
			case .hold(let label):
				if let option = option(labelled: label) {
					WatchHoldReason { reason in
						store.choose(option, note: HoldReason.normalized(reason), on: card)
						WKInterfaceDevice.current().play(.success)
						self.route = nil
					}
				}
			case .all:
				WatchAllOptions(
					ask: ask, options: WatchDecisionOptions.listed(options),
					hold: WatchDecisionOptions.hold(options)
				) { option in
					choose(option)
				}
			}
		}
	}

	private var ask: String { card.decision?.ask.nonEmpty ?? card.headline }

	@ViewBuilder
	private var decision: some View {
		WatchDecisionHeader(sender: store.senderName(of: card) ?? "Chief of Staff", position: position)
		Text(ask)
			.font(WatchType.question()).foregroundStyle(MaskinColor.ink)
			.lineLimit(3)
		if let reason = WatchDecisionOptions.reasonLine(card.decision?.summary ?? "") {
			Text(reason)
				.font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				.lineLimit(2)
		}
		if let primary = WatchDecisionOptions.primary(options) {
			Button { choose(primary) } label: {
				WatchCapsule(title: primary.label, prominent: true, font: WatchType.option(recommended: true))
			}
			.buttonStyle(.plain)
		}
		HStack(spacing: MaskinSpace.gapDefault) {
			if let hold = WatchDecisionOptions.hold(options) {
				Button { route = .hold(hold.id) } label: { WatchCapsule(title: "Hold") }
					.buttonStyle(.plain)
			}
			if WatchDecisionOptions.hasMore(options) {
				Button { route = .all } label: { WatchCapsule(title: "More") }
					.buttonStyle(.plain)
			}
		}
	}

	private func choose(_ option: DecisionOption) {
		if WatchDecisionOptions.isHold(option) {
			route = .hold(option.id)
		} else if WatchDecisionOptions.needsConfirmation(option) {
			route = .confirm(option.id)
		} else {
			decide(option)
			route = nil
		}
	}

	private func decide(_ option: DecisionOption) {
		store.choose(option, on: card)
		WKInterfaceDevice.current().play(.success)
	}

	private func receipt(_ record: DecisionRecord) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
			Image(systemName: "checkmark")
				.font(.system(size: MaskinFontSize.t18, weight: .bold))
				.frame(width: WatchMetrics.target, height: WatchMetrics.target)
				.background(MaskinSurface.inverse, in: Circle())
				.foregroundStyle(MaskinSurface.onInverse)
			Text(receiptTitle(record)).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
			if case .option(let label) = record.kind, HoldReason.isHold(label), let reason = record.note {
				Text(WatchDecisionOptions.heldNote(reason: reason))
					.font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
			}
			switch record.phase {
			case .held:
				Text("Undo any time in the next hour.").font(WatchType.caption()).foregroundStyle(MaskinColor.ink4)
				Button { _ = store.undo(card) } label: { WatchCapsule(title: "Undo") }
					.buttonStyle(.plain)
				advance
			case .queued:
				Text("Queued, sends when you're back.").font(WatchType.caption()).foregroundStyle(MaskinColor.sigHi)
				advance
			default:
				EmptyView()
			}
		}
	}

	/// "Next" moves to the following decision; the last one says "Done" and ends the run.
	@ViewBuilder
	private var advance: some View {
		if let next {
			Button(action: next) { WatchCapsule(title: "Next", prominent: true) }
				.buttonStyle(.plain)
		} else {
			Button {
				finish()
				dismiss()
			} label: { WatchCapsule(title: "Done", prominent: true) }
				.buttonStyle(.plain)
		}
	}

	private func receiptTitle(_ record: DecisionRecord) -> String {
		switch record.kind {
		case .option(let label): WatchDecisionOptions.receiptTitle(for: label)
		case .reply: "Sent"
		case .dismissed: "Marked read"
		}
	}

	/// A rejected decision rolls the card back to how it was, options and all.
	private func isFailed(_ record: DecisionRecord) -> Bool {
		if case .failed = record.phase { return true }
		return false
	}
}

/// Every option, one capsule each in the iPhone's order, then Hold. A plain list: the page scrolls
/// with the Crown and nothing inside it does.
private struct WatchAllOptions: View {
	let ask: String
	let options: [DecisionOption]
	let hold: DecisionOption?
	let choose: (DecisionOption) -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
				Text("ALL OPTIONS")
					.font(WatchType.microMono()).tracking(0.8)
					.foregroundStyle(MaskinColor.ink4)
				Text(ask).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).lineLimit(3)
				ForEach(options) { option in
					Button { choose(option) } label: {
						WatchCapsule(
							title: option.label, prominent: option.recommended,
							font: WatchType.option(recommended: option.recommended))
					}
					.buttonStyle(.plain)
				}
				if let hold {
					Button { choose(hold) } label: { WatchCapsule(title: "Hold") }
						.buttonStyle(.plain)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationBarBackButtonHidden()
	}
}

/// A decision from the last snapshot: readable without a connection, decided on the iPhone.
private struct WatchSnapshotPage: View {
	let card: WatchSnapshot.Card
	let position: String
	let updatedAt: Date?
	let offline: Bool

	private var header: String? {
		guard let updatedAt else { return offline ? "OFFLINE" : nil }
		return offline
			? WatchDecisionOptions.offlineHeader(updatedAt: updatedAt, now: Date())
			: WatchDecisionOptions.updatedHeader(updatedAt: updatedAt, now: Date())
	}

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if let header {
					Text(header).font(WatchType.microMono()).tracking(0.6).foregroundStyle(MaskinColor.ink4)
				}
				WatchDecisionHeader(sender: card.sender, position: position)
				Text(card.ask.nonEmpty ?? card.headline)
					.font(WatchType.question()).foregroundStyle(MaskinColor.ink)
					.lineLimit(3)
				if let reason = WatchDecisionOptions.reasonLine(card.summary) {
					Text(reason).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3).lineLimit(2)
				}
				if let primary = WatchDecisionOptions.primary(card.options) {
					Text(primary.label).font(WatchType.row()).foregroundStyle(MaskinColor.ink2)
				}
				Label(offline ? "Decide on your iPhone." : "Open on iPhone", systemImage: "iphone")
					.font(WatchType.caption())
					.foregroundStyle(MaskinColor.ink4)
					.frame(minHeight: WatchMetrics.target)
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			.padding(.horizontal, MaskinSpace.s1)
		}
	}
}

/// Hold asks why, as the iPhone does: two presets, dictation, or skip. The reason is stored as
/// the iPhone stores it and shown as "Held · your reason: …".
private struct WatchHoldReason: View {
	let decide: (String?) -> Void
	@State private var dictated = ""

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
				Text("Why are you holding it?").font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				ForEach(WatchDecisionOptions.holdPresets, id: \.self) { reason in
					Button { decide(reason) } label: { WatchCapsule(title: reason) }.buttonStyle(.plain)
				}
				TextField("Dictate", text: $dictated)
					.font(WatchType.question())
					.submitLabel(.done)
					.onSubmit { decide(dictated) }
					.frame(minHeight: WatchMetrics.target)
				WatchQuietButton(title: "Skip") { decide(nil) }
			}
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationBarBackButtonHidden()
	}
}

private struct WatchConfirm: View {
	let option: DecisionOption
	let confirm: () -> Void
	let cancel: () -> Void

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.gapDefault) {
				Text(WatchDecisionOptions.confirmTitle(for: option.label)).font(WatchType.question()).foregroundStyle(MaskinColor.ink)
				ForEach(option.consequences, id: \.self) { line in
					Text(line).font(WatchType.caption()).foregroundStyle(MaskinColor.ink3)
				}
				Button(action: confirm) {
					WatchCapsule(title: "Confirm", prominent: true, font: WatchType.action())
				}
				.buttonStyle(.plain)
				Button(action: cancel) {
					WatchCapsule(title: "Cancel", font: WatchType.action())
				}
				.buttonStyle(.plain)
			}
		}
		.containerBackground(for: .navigation) { WatchBackdrop() }
		.navigationBarBackButtonHidden()
	}
}

private extension String {
	var nonEmpty: String? {
		let t = trimmingCharacters(in: .whitespacesAndNewlines)
		return t.isEmpty ? nil : t
	}
}
