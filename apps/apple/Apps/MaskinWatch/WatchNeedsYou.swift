import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Decisions waiting on the wearer, one card per page. One tap decides (optimistic, held for the
/// Undo window). Every option the iPhone card has is here, in order, scrolling with the Digital
/// Crown; one that can't be taken back asks first, and Hold asks why. When the watch can't reach
/// the feed, the last snapshot (from the phone or its own last read) is shown read-only.
struct WatchNeedsYou: View {
	let store: ForYouStore?
	let watch: MaskinWatchStore
	let workspaceId: String?

	@State private var selection: String?

	private var entries: [FeedEntry] {
		(store?.entries ?? []).filter { $0.section == .needs }
	}

	private var count: Int { store != nil && !entries.isEmpty ? (store?.needsCount ?? 0) : watch.needsCount }

	var body: some View {
		NavigationStack {
			content
				.navigationTitle("Needs you")
				.toolbar {
					ToolbarItem(placement: .topBarLeading) {
						MaskinLogoTile(size: MaskinSpace.s10).accessibilityHidden(true)
					}
					if count > 0 {
						ToolbarItem(placement: .topBarTrailing) { WatchCountBadge(count: count) }
					}
				}
				.containerBackground(for: .navigation) { WatchBackdrop() }
		}
	}

	@ViewBuilder
	private var content: some View {
		if let store, !entries.isEmpty {
			TabView(selection: $selection) {
				ForEach(Array(entries.enumerated()), id: \.element.id) { index, entry in
					WatchDecisionPage(
						store: store, entry: entry, workspaceId: workspaceId,
						remaining: entries[(index + 1)...].filter { $0.record == nil }.count,
						next: index + 1 < entries.count ? { selection = entries[index + 1].id } : nil)
					.tag(Optional(entry.id))
				}
			}
			.tabViewStyle(.page)
		} else if !watch.cards.isEmpty, store?.isEmpty != true {
			// Offline or still loading: the last known state, read only.
			TabView {
				ForEach(watch.cards) { card in WatchSnapshotPage(card: card, offline: watch.isOffline) }
			}
			.tabViewStyle(.page)
		} else if let store, store.phase == .loading, store.cards.isEmpty {
			ProgressView()
		} else if let store, case .failed(let message) = store.phase, store.cards.isEmpty {
			EmptyState(symbol: "wifi.exclamationmark", title: "Can't load", message: message) {
				Button("Retry") { Task { await store.load() } }
					.frame(minHeight: WatchMetrics.target)
			}
		} else {
			EmptyState(symbol: "checkmark.circle", title: "You're caught up")
		}
	}
}

/// The message block shared by the live and the snapshot page.
private struct WatchMessage: View {
	let sender: String
	let at: Date?
	let text: String
	let ask: String?
	/// The object the decision is about; underlined where the message names it, else shown as a
	/// link line under the message.
	var objectName: String?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			HStack(spacing: MaskinSpace.gapDefault) {
				WatchTile(name: sender)
				Text(sender).font(WatchType.name()).foregroundStyle(MaskinColor.ink).lineLimit(1)
				Spacer(minLength: 0)
				if let at {
					Text(at.formatted(date: .omitted, time: .shortened))
						.font(WatchType.mono()).foregroundStyle(MaskinColor.ink4)
				}
			}
			linked
				.font(WatchType.body())
				.lineSpacing(MaskinSpace.s1 + 1)
				.lineLimit(4)
				.foregroundStyle(MaskinColor.ink)
			if let objectName = unlinkedObjectName(objectName) {
				link(objectName).font(WatchType.caption()).lineLimit(1)
			}
			if let ask, !ask.isEmpty {
				Text(ask).font(WatchType.question()).foregroundStyle(MaskinColor.ink3)
			}
		}
	}
}

extension WatchMessage {
	/// The message with the object's name underlined in the `sigHi` link colour.
	fileprivate var linked: Text {
		guard let name = objectName?.nonEmpty, let range = text.range(of: name, options: .caseInsensitive)
		else { return Text(text) }
		let before = String(text[..<range.lowerBound])
		let after = String(text[range.upperBound...])
		return Text("\(before)\(link(String(text[range])))\(after)")
	}

	/// The object's name when the message does not already say it.
	fileprivate func unlinkedObjectName(_ name: String?) -> String? {
		guard let name = name?.nonEmpty, text.range(of: name, options: .caseInsensitive) == nil else { return nil }
		return name
	}

	fileprivate func link(_ name: String) -> Text {
		Text(name).underline(true, color: MaskinColor.sigHi)
	}
}

private struct WatchDecisionPage: View {
	let store: ForYouStore
	let entry: FeedEntry
	let workspaceId: String?
	/// Decisions still open behind this one, for the footer.
	let remaining: Int
	/// Moves the pager to the next decision; nil on the last one.
	let next: (() -> Void)?
	// Option labels (an option's id): `navigationDestination(item:)` wants a Hashable value.
	@State private var confirming: String?
	@State private var holding: String?

	private func option(labelled label: String) -> DecisionOption? { options.first { $0.id == label } }

	private var card: ForYouCard { entry.card }
	private var options: [DecisionOption] { WatchDecisionOptions.all(card.decision?.options ?? []) }

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				if let record = entry.record, !isFailed(record) {
					receipt(record)
				} else {
					WatchMessage(
						sender: store.senderName(of: card) ?? "Chief of Staff", at: card.latestActivityAt,
						text: card.decision?.summary.nonEmpty ?? card.headline, ask: card.decision?.ask,
						objectName: card.objectTitle)
					optionList
					Label("Open on iPhone", systemImage: "iphone")
						.font(WatchType.caption())
						.foregroundStyle(MaskinColor.ink3)
						.frame(maxWidth: .infinity, minHeight: WatchMetrics.target)
						.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
					Text(WatchDecisionOptions.remainingLabel(remaining))
						.font(WatchType.microMono())
						.tracking(0.6)
						.foregroundStyle(MaskinColor.ink4)
						.frame(maxWidth: .infinity)
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
		.navigationDestination(item: $confirming) { label in
			if let option = option(labelled: label) {
				WatchConfirm(option: option) {
					store.choose(option, on: card)
					confirming = nil
				} cancel: {
					confirming = nil
				}
			}
		}
		.navigationDestination(item: $holding) { label in
			if let option = option(labelled: label) {
				WatchHoldReason { reason in
					store.choose(option, note: HoldReason.normalized(reason), on: card)
					holding = nil
				}
			}
		}
	}

	/// Every option in the iPhone's order. More than three scroll inside their own block, which
	/// the Crown drives once it is focused; three or fewer lie flat on the page.
	@ViewBuilder
	private var optionList: some View {
		let rows = VStack(spacing: MaskinSpace.gapDefault) {
			ForEach(options) { option in
				Button { choose(option) } label: {
					WatchCapsule(
						title: option.label, prominent: option.recommended,
						font: WatchType.option(recommended: option.recommended))
				}
				.buttonStyle(.plain)
			}
		}
		if options.count > WatchDecisionOptions.visibleRows {
			let rowHeight = WatchMetrics.target + MaskinSpace.gapDefault
			ScrollView(.vertical) { rows }
				.frame(height: rowHeight * CGFloat(WatchDecisionOptions.visibleRows) - MaskinSpace.gapDefault)
		} else {
			rows
		}
	}

	private func choose(_ option: DecisionOption) {
		if WatchDecisionOptions.isHold(option) {
			holding = option.id
		} else if WatchDecisionOptions.needsConfirmation(option) {
			confirming = option.id
		} else {
			store.choose(option, on: card)
		}
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
				Button("Undo") { _ = store.undo(card) }
					.buttonStyle(SecondaryActionButtonStyle())
					.frame(minHeight: WatchMetrics.target)
				if let next {
					Button("Next", action: next)
						.buttonStyle(PrimaryActionButtonStyle())
						.frame(minHeight: WatchMetrics.target)
				}
			case .queued:
				Text("Queued, sends when you're back.").font(WatchType.caption()).foregroundStyle(MaskinColor.sigHi)
			default:
				EmptyView()
			}
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

/// A decision from the last snapshot: readable without a connection, decided on the iPhone.
private struct WatchSnapshotPage: View {
	let card: WatchSnapshot.Card
	let offline: Bool

	var body: some View {
		ScrollView {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				WatchMessage(
					sender: card.sender, at: card.at,
					text: card.summary.nonEmpty ?? card.headline, ask: card.ask,
					objectName: card.objectTitle)
				Label(offline ? "Offline. Decide on iPhone." : "Open on iPhone", systemImage: "iphone")
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
