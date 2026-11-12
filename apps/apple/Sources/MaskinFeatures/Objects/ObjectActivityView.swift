import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

/// The Activity page: events grouped by local day, newest first, read like a group chat. Every
/// comment is a message (avatar, name, time, card bubble, shown in full); system events are one
/// quiet line. Replies form a thread: smaller bubbles on a rail under their parent, headed by a
/// reply count. Holding an event offers Reply, which hands the item to the composer.
struct ObjectActivityView: View {
	let store: ObjectDetailStore
	var onOpenObject: ((String) -> Void)?
	var onReply: ((TimelineItem) -> Void)?
	/// Which items to show; the whole timeline by default.
	var include: (TimelineItem) -> Bool = { _ in true }
	/// Pins "now" for snapshots; the live page uses the clock.
	var now: Date = Date()
	/// Shown instead of the store's timeline, when the page merges more into it (a flow's room).
	var items: [TimelineItem]?
	/// Replaces the default words when there is nothing to show at all.
	var emptyState: (title: String, body: String)?
	/// Retry or discard an item that is not one of the store's comments (a room message).
	var onRetry: ((TimelineItem) -> Bool)?
	var onDiscard: ((TimelineItem) -> Bool)?

	@State private var filter: ActivityFilter = .all
	@State private var retrying = false

	private var loadState: ActivityLoadState {
		.of(
			fetched: store.hasFetched, revalidateFailed: store.freshness.lastRevalidateFailed,
			hasItems: !(items ?? store.timeline).isEmpty, retrying: retrying)
	}

	var body: some View {
		let days = ActivityGrouping.days(filter.apply(to: (items ?? store.timeline).filter(include)), now: now)
		let dividers = filter == .all
			? ActivityPhases.dividers(
				newestFirst: days.flatMap { $0.entries.map(\.id) },
				statuses: ActivityPhases.statuses(of: items ?? store.timeline))
			: [:]
		VStack(alignment: .leading, spacing: 0) {
			ActivityFilterChips(selected: $filter)
				.padding(.bottom, MaskinSpace.s3)
			if days.isEmpty {
				switch loadState {
				case .failed:
					ActivityLoadFailed {
						retrying = true
						Task {
							await store.refresh()
							retrying = false
						}
					}
				case .loading:
					LoadingSkeleton(rows: 3)
				case .ready:
					if let emptyState, filter == .all {
						VStack(alignment: .leading, spacing: MaskinSpace.s2) {
							Text(emptyState.title).maskinText(.body).fontWeight(.semibold)
								.foregroundStyle(MaskinColor.ink)
							Text(emptyState.body).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
						}
						.padding(.top, MaskinSpace.s5)
						.accessibilityElement(children: .combine)
					} else {
						Text(filter == .all ? "No activity yet. Start the conversation below." : "Nothing under \(filter.title) yet.")
							.maskinText(.subhead)
							.foregroundStyle(MaskinColor.ink4)
							.padding(.top, MaskinSpace.s5)
					}
				}
			}
			ForEach(days) { day in
				Text(day.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
					.foregroundStyle(MaskinColor.ink5)
					.padding(.horizontal, MaskinSpace.s4)
					.padding(.top, MaskinSpace.s8)
					.padding(.bottom, MaskinSpace.s3)
					.accessibilityAddTraits(.isHeader)
				ForEach(day.entries) { entry in
					ActivityEntryView(
						store: store, entry: entry, onOpenObject: onOpenObject, onReply: onReply, onRetry: onRetry,
						onDiscard: onDiscard
					)
					.id(entry.id)
					if let status = dividers[entry.id] {
						PhaseDivider(label: MaskinStatus.sentenceLabel(for: status))
					}
				}
			}
			if !days.isEmpty, onReply != nil {
				Text("Hold an event to reply")
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity)
					.padding(.top, MaskinSpace.s9)
			}
		}
		.accessibilityElement(children: .contain)
	}
}

/// "—— REVIEW ——": where the object entered a status, between the entries before and after.
struct PhaseDivider: View {
	let label: String

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			rule
			Text(label.uppercased())
				.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .bold, relativeTo: .caption))
				.tracking(MaskinSpace.s1)
				.foregroundStyle(MaskinColor.ink5)
			rule
		}
		.padding(.vertical, MaskinSpace.s5)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(label) phase")
	}

	private var rule: some View {
		Rectangle().fill(MaskinSurface.separator).frame(height: MaskinSpace.s1 / 2)
	}
}

/// All · Comments · Updates: a quiet pill row above the timeline; the chosen one is soft-filled.
struct ActivityFilterChips: View {
	@Binding var selected: ActivityFilter

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			ForEach(ActivityFilter.allCases) { option in
				let active = option == selected
				Button {
					MaskinHaptics.play(.selection)
					selected = option
				} label: {
					Text(option.title)
						.maskinText(.subhead)
						.fontWeight(active ? .bold : .semibold)
						.foregroundStyle(active ? MaskinColor.ink : MaskinColor.ink4)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(height: MaskinSpace.s14)
						.background(active ? MaskinSurface.fill : Color.clear, in: Capsule())
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed(.shrink))
				.accessibilityAddTraits(active ? .isSelected : [])
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Filter activity")
	}
}

/// "Activity did not load" with a way back, in place of the skeleton when the first fetch failed.
struct ActivityLoadFailed: View {
	let retry: () -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			Text("Activity did not load").maskinText(.body).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink)
			Text("Your connection dropped. Nothing was lost.")
				.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
			Button("Try again", action: retry)
				.maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.sigInk)
				.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.padding(MaskinSpace.s9)
		.background(MaskinSurface.fill, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.accessibilityElement(children: .contain)
	}
}

/// One event with its replies.
struct ActivityEntryView: View {
	let store: ObjectDetailStore
	let entry: ActivityEntry
	var onOpenObject: ((String) -> Void)?
	var onReply: ((TimelineItem) -> Void)?
	var onRetry: ((TimelineItem) -> Bool)?
	var onDiscard: ((TimelineItem) -> Bool)?

	/// The page may own the item (a room message); otherwise it is one of the store's comments.
	private func retry(_ item: TimelineItem) {
		if onRetry?(item) == true { return }
		Task { await store.retryComment(item.id) }
	}

	private func discard(_ item: TimelineItem) {
		if onDiscard?(item) == true { return }
		store.discardComment(item.id)
	}

	private static var replyIndent: CGFloat { MaskinSpace.s12 + MaskinSpace.s1 }

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			row(entry)
				.contextMenu { menu(for: entry.item) }
			if !entry.replies.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					Text(entry.replies.count == 1 ? "1 reply" : "\(entry.replies.count) replies")
						.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
						.foregroundStyle(MaskinColor.ink4)
					ForEach(entry.replies) { reply in
						ReplyRow(
							item: reply.item, name: store.authorName(for: reply.item), isAgent: store.isAgent(reply.item),
							time: reply.timeLabel, mentionable: Array(store.directory.actors.values))
							.contextMenu { menu(for: reply.item) }
					}
				}
				.padding(.leading, MaskinSpace.s7)
				.overlay(alignment: .leading) {
					RoundedRectangle(cornerRadius: MaskinRadius.tag / 2, style: .continuous)
						.fill(MaskinSurface.separator).frame(width: MaskinSpace.s1)
				}
				.padding(.leading, Self.replyIndent)
				.padding(.top, MaskinSpace.s1)
				.padding(.bottom, MaskinSpace.s4)
			}
		}
	}

	@ViewBuilder private func row(_ entry: ActivityEntry) -> some View {
		switch entry.kind {
		case .comment:
			TimelineRow(
				item: entry.item, name: store.authorName(for: entry.item), isAgent: store.isAgent(entry.item),
				mentionable: Array(store.directory.actors.values), references: store.references(for: entry.item),
				files: store.attachments(for: entry.item), openObject: onOpenObject,
				tasks: entry.item.taskIds.map { id in (id: id, state: store.taskStates[id] ?? nil) },
				decision: entry.item.decision,
				decisionAnswer: entry.item.decision?.answer(in: entry.replies.compactMap { reply in
					if case .comment(let text) = reply.item.kind { return text } else { return nil }
				}),
				onAnswer: { label in
					guard let parent = entry.item.eventId else { return }
					Task { await store.postComment(label, parentEventId: parent) }
				},
				retry: { retry(entry.item) },
				discard: { discard(entry.item) },
				time: entry.timeLabel)
		case .event:
			QuietEventRow(
				who: store.authorName(for: entry.item), what: ActivityGrouping.summary(of: entry.item),
				time: entry.timeLabel, delivery: entry.item.delivery,
				retry: { retry(entry.item) },
				discard: { discard(entry.item) })
		}
	}

	@ViewBuilder private func menu(for item: TimelineItem) -> some View {
		if let onReply, !item.isLocal {
			Button { onReply(item) } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
		}
		if case .comment(let text) = item.kind {
			Button {
				ActivityClipboard.copy(text)
				MaskinHaptics.play(.selection)
			} label: {
				Label("Copy text", systemImage: "doc.on.doc")
			}
		}
	}
}

/// "• **Forge** moved status to active · 14:02": a system event or a short remark on one line.
struct QuietEventRow: View {
	let who: String
	let what: String
	var time: String?
	var delivery: TimelineItem.Delivery = .sent
	var retry: () -> Void = {}
	var discard: () -> Void = {}

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
				Circle().fill(MaskinColor.ink5)
					.frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					.alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + MaskinSpace.s2 }
				(Text(who).fontWeight(.semibold).foregroundStyle(MaskinColor.ink2) + Text(" ") + Text(what))
					.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink4)
					.lineSpacing(MaskinSpace.s1)
					.frame(maxWidth: .infinity, alignment: .leading)
				if let time {
					Text(time)
						.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
						.foregroundStyle(MaskinColor.ink5)
				}
			}
			.padding(.leading, MaskinSpace.s5)
			.padding(.trailing, MaskinSpace.s4)
			.padding(.vertical, MaskinSpace.s3)
			.opacity(delivery == .sending ? 0.55 : 1)
			DeliveryFooter(delivery: delivery, retry: retry, discard: discard)
				.padding(.leading, MaskinSpace.s5 + MaskinSpace.s3 + MaskinSpace.s5)
		}
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
		.accessibilityLabel([who, what, time].compactMap { $0 }.joined(separator: ", "))
	}
}

/// A comment as a chat message: avatar, name and time, then a card bubble with the full text. The
/// same row also draws system items when asked directly (older call sites), so a `.activity` item
/// renders as a quiet line.
struct TimelineRow: View {
	let item: TimelineItem
	let name: String
	let isAgent: Bool
	/// Who an `@Name` in a comment can refer to; those names render as mentions.
	var mentionable: [ActorRef] = []
	/// Objects linked from the comment (`/`), shown as chips under it.
	var references: [CommentReference] = []
	/// Files attached to the comment, as cards under it.
	var files: [FileSummary] = []
	var openObject: ((String) -> Void)?
	/// Tasks the comment lists; `state` is nil while loading or when the task is gone.
	var tasks: [(id: String, state: ObjectDetailStore.TaskState?)] = []
	var decision: CommentDecision?
	/// The option already taken, by a reply.
	var decisionAnswer: String?
	var onAnswer: (String) -> Void = { _ in }
	var retry: () -> Void = {}
	var discard: () -> Void = {}
	/// Clock time, only when the comment is from today.
	var time: String?

	private static var avatar: CGFloat { MaskinSpace.s13 + MaskinSpace.s1 }

	var body: some View {
		switch item.kind {
		case .comment(let text):
			HStack(alignment: .top, spacing: MaskinSpace.s5) {
				ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: Self.avatar, seed: item.actorId)
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
						Text(name)
							.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .semibold, relativeTo: .body))
							.foregroundStyle(MaskinColor.ink)
						// Times show only for today; the day heading dates everything older.
						if let time {
							Text(time)
								.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
								.foregroundStyle(MaskinColor.ink5)
						}
					}
					.frame(minHeight: MaskinSpace.s11)
					bubble(text)
					if !tasks.isEmpty { CommentTaskList(tasks: tasks, open: openObject) }
					if let decision { CommentDecisionCard(decision: decision, answer: decisionAnswer, onAnswer: onAnswer) }
					if !files.isEmpty {
						ChipFlow { ForEach(files) { AttachedFileChip(file: $0) } }
					}
					if !references.isEmpty {
						ChipFlow {
							ForEach(references) { ref in
								ReferenceChip(ref: ref, onOpen: openObject.map { open in { open(ref.id) } })
							}
						}
					}
					DeliveryFooter(delivery: item.delivery, retry: retry, discard: discard)
				}
			}
			.padding(.vertical, MaskinSpace.s4)
			.contentShape(Rectangle())
			.accessibilityElement(children: .contain)
		case .activity(let summary):
			QuietEventRow(who: name, what: summary, time: time, delivery: item.delivery, retry: retry, discard: discard)
		}
	}

	private func bubble(_ text: String) -> some View {
		MarkdownContent(CommentMentions.linked(text, actors: mentionable), style: .description, hardBreaks: true)
			.fixedSize(horizontal: false, vertical: true)
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s6)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(
			MaskinSurface.card,
			in: UnevenRoundedRectangle(
				topLeadingRadius: MaskinRadius.tag * 2, bottomLeadingRadius: MaskinRadius.hero,
				bottomTrailingRadius: MaskinRadius.hero, topTrailingRadius: MaskinRadius.hero, style: .continuous))
		.opacity(item.delivery == .sending ? 0.55 : 1)
	}
}

/// A reply under its parent: 22pt avatar, name and time, the text.
struct ReplyRow: View {
	let item: TimelineItem
	let name: String
	let isAgent: Bool
	var time: String?
	var mentionable: [ActorRef] = []

	private static var avatar: CGFloat { MaskinSpace.s11 + MaskinSpace.s1 }

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			ActorAvatar(name: name, kind: isAgent ? .agent : .human, size: Self.avatar, seed: item.actorId)
				.padding(.top, MaskinSpace.s1 / 2)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
					Text(name)
						.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: .semibold, relativeTo: .footnote))
						.foregroundStyle(MaskinColor.ink)
					if let time {
						Text(time)
							.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption))
							.foregroundStyle(MaskinColor.ink5)
					}
				}
				switch item.kind {
				case .comment(let text):
					MarkdownContent(CommentMentions.linked(text, actors: mentionable), style: .description, hardBreaks: true)
						.padding(.horizontal, MaskinSpace.s6)
						.padding(.vertical, MaskinSpace.s4)
						.frame(maxWidth: .infinity, alignment: .leading)
						.background(
							MaskinSurface.card,
							in: UnevenRoundedRectangle(
								topLeadingRadius: MaskinRadius.tag, bottomLeadingRadius: MaskinRadius.hero,
								bottomTrailingRadius: MaskinRadius.hero, topTrailingRadius: MaskinRadius.hero, style: .continuous))
				case .activity(let summary):
					Text(summary)
						.font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
						.foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.opacity(item.delivery == .sending ? 0.55 : 1)
		.contentShape(Rectangle())
		.accessibilityElement(children: .combine)
	}
}

/// "Not sent · Retry · Discard" under a comment the server refused.
struct DeliveryFooter: View {
	let delivery: TimelineItem.Delivery
	var retry: () -> Void = {}
	var discard: () -> Void = {}

	var body: some View {
		if delivery == .failed {
			HStack(spacing: MaskinSpace.s6) {
				Label("Not sent", systemImage: "exclamationmark.circle.fill")
					.foregroundStyle(MaskinColor.dangerStrong)
				Button("Retry", action: retry).foregroundStyle(MaskinColor.ink)
				Button("Discard", role: .destructive, action: discard)
			}
			.maskinText(.caption)
			.buttonStyle(.borderless)
			.frame(minHeight: MaskinSpace.touchMin)
		}
	}
}

enum ActivityClipboard {
	static func copy(_ string: String) {
		#if os(iOS)
		UIPasteboard.general.string = string
		#elseif os(macOS)
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(string, forType: .string)
		#endif
	}
}
