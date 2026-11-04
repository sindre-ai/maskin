import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// A live call in the thread: one card that holds the whole conversation, closed to a one-line
/// preview and open to the transcript. Its lines are real chat messages, so the agent has them
/// and other devices see them; only the thread's layout folds them into this card.
///
/// While the call runs the card is open and follows the newest line, with the words you are saying
/// right now as a trailing "speaking…" line; when the call ends it closes.
struct LiveCallCardView: View {
	let card: LiveCallCard
	/// What you are saying now (empty when nothing, or when the call is over).
	var partial = ""

	@State private var override: Bool?
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	private var expanded: Bool { override ?? card.startsExpanded }

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s6) {
			header
			if expanded { transcript } else { collapsed }
			if !card.mentioned.isEmpty { chips }
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.tile, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.animation(MaskinMotion.standard, value: expanded)
		.onChange(of: card.isActive) { _, _ in override = nil }
		.accessibilityElement(children: .contain)
	}

	// MARK: Header

	private var header: some View {
		Button {
			let next = !expanded
			override = next
			LiveCallLog.shared.update(card.record.id) { $0.expanded = next }
			MaskinHaptics.play(.light)
		} label: {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Image(systemName: card.isActive ? "waveform" : "mic.fill")
					.foregroundStyle(MaskinColor.ink3)
					.accessibilityHidden(true)
				VStack(alignment: .leading, spacing: MaskinSpace.s1) {
					Text(card.title).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
						.fixedSize(horizontal: false, vertical: true)
					// The running clock lives in the call panel; here only a finished call shows its length.
					if !card.isActive {
						Text(card.durationText(now: card.record.endedAt ?? card.record.startedAt))
							.maskinText(.caption).foregroundStyle(MaskinColor.ink4).monospacedDigit()
					}
				}
				Spacer(minLength: MaskinSpace.s3)
				Image(systemName: "chevron.down")
					.maskinSymbol(MaskinFontSize.t12, weight: .semibold)
					.foregroundStyle(MaskinColor.ink4)
					.rotationEffect(.degrees(expanded ? 180 : 0))
					.accessibilityHidden(true)
			}
			.contentShape(Rectangle())
		}
		.buttonStyle(.plain)
		.accessibilityLabel("Live call with \(card.record.leadName)")
		.accessibilityValue(expanded ? "Expanded" : "Collapsed")
		.accessibilityHint(expanded ? "Collapses the transcript" : "Expands the transcript")
	}

	// MARK: Collapsed

	@ViewBuilder private var collapsed: some View {
		if card.messages.isEmpty {
			emptyText
		} else {
			if let preview = card.preview {
				Text(preview).maskinText(.subhead).foregroundStyle(MaskinColor.ink).lineLimit(2)
			}
			Text(card.counts).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		}
	}

	@ViewBuilder private var emptyText: some View {
		if card.isActive {
			Text(partial.isEmpty ? "Listening…" : partial).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
		} else {
			Text(LiveMeetingNote.emptyText).maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
		}
	}

	// MARK: Expanded

	private var transcript: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			if card.messages.isEmpty && (partial.isEmpty || !card.isActive) { emptyText }
			ForEach(card.messages) { message in
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Text(card.isYou(message) ? LiveMeetingNote.youName : message.actorName)
						.maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
					if card.isYou(message) {
						Text(message.content).maskinText(.body).foregroundStyle(MaskinColor.ink)
					} else {
						MarkdownContent(message.content, style: .chat)
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
				.accessibilityElement(children: .combine)
			}
			if card.isActive, !partial.isEmpty {
				VStack(alignment: .leading, spacing: MaskinSpace.s2) {
					Label("You · speaking…", systemImage: "mic.fill")
						.maskinText(.caption).fontWeight(.semibold).foregroundStyle(MaskinColor.ink4)
					Text(partial).maskinText(.body).foregroundStyle(MaskinColor.ink3)
				}
				.accessibilityElement(children: .combine)
			}
		}
		.textSelection(.enabled)
	}

	// MARK: Objects

	private var chips: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				ForEach(card.mentioned.prefix(8)) { object in
					Button { runtime?.openObject(object.id) } label: {
						Label(object.title, systemImage: "doc.text")
							.maskinText(.caption).foregroundStyle(MaskinColor.ink2).lineLimit(1)
							.padding(.horizontal, MaskinSpace.s5).padding(.vertical, MaskinSpace.s3)
							.background(MaskinSurface.fillStrong, in: Capsule())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Open \(object.title)")
				}
			}
		}
	}
}
