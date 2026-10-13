import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A day separator or system divider line.
struct ThreadDivider: View {
	let label: String
	/// Colours the label (the "NEW" marker); nil keeps the quiet default.
	var tint: Color?
	/// Colours the rules; nil keeps the hairline.
	var ruleTint: Color?
	/// False for a system line ("Sebastian added CPO"): centred grey text with no rules.
	var ruled = true
	/// A mono, uppercase label (days and the NEW marker).
	var mono = false
	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			if ruled { line }
			Group {
				if mono {
					MonoLabel(label, color: tint ?? MaskinColor.ink5)
				} else {
					Text(label).maskinText(.caption).foregroundStyle(tint ?? MaskinColor.ink4).lineLimit(2)
						.multilineTextAlignment(.center)
						.frame(maxWidth: ruled ? nil : .infinity)
				}
			}
			if ruled { line }
		}
		.padding(.vertical, MaskinSpace.s4)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	private var line: some View {
		Rectangle().fill(ruleTint ?? MaskinSurface.line).frame(height: 1)
	}
}

/// What a message attaches: photos as pictures (one large, several as tiles) and every other file
/// as a chip. Each opens the file.
struct MessageAttachments: View {
	let attachments: [ChatAttachmentRef]
	var alignment: HorizontalAlignment = .leading

	var body: some View {
		if !attachments.isEmpty {
			let photos = attachments.filter(\.isImage)
			let files = attachments.filter { !$0.isImage }
			VStack(alignment: alignment, spacing: MaskinSpace.s3) {
				if photos.count == 1, let photo = photos.first {
					AttachmentThumbnail(file: photo, style: .large)
				} else if photos.count > 1 {
					ChipFlow {
						ForEach(photos) { AttachmentThumbnail(file: $0, style: .tile) }
					}
				}
				if !files.isEmpty {
					ChipFlow { ForEach(files) { MessageFileChip(file: $0) } }
				}
			}
			.frame(maxWidth: .infinity, alignment: alignment == .trailing ? .trailing : .leading)
		}
	}
}

/// "You mentioned Relay" / "Mentioned Relay, Sam".
struct MentionLine: View {
	let names: [String]
	let isOwn: Bool

	var body: some View {
		if !names.isEmpty {
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: "at").accessibilityHidden(true)
				Text("\(isOwn ? "You mentioned" : "Mentioned") \(names.joined(separator: ", "))")
					.lineLimit(2)
			}
			.maskinText(.caption)
			.foregroundStyle(MaskinColor.sigInk)
			.accessibilityElement(children: .combine)
		}
	}
}

/// One message (7-Chat §3). Everyone else's (people and agents) is a `card` bubble with a small tail
/// at the top left, under a header of a 24pt avatar, the name and the time; follow-ups from the same
/// author drop the header and sit 5pt below. Yours is an `inverse` bubble on the right with its tail
/// at the bottom right, no header, and a status line under your latest one only. A long-press opens
/// the message menu; a swipe to the right replies. Words are rendered as markdown and selectable. An
/// agent's question renders as tappable options under its text.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	var mentionNames: [String] = []
	/// The tagged people (id and full name). Their `@Name` in the text is shown bold.
	var mentions: [(id: String, name: String)] = []
	/// What the human picked, once this question has been answered.
	var questionAnswers: [ChatQuestionAnswer.Answer]?
	/// Where your message stands; set on your latest message and on any that is still going or failed.
	var outgoing: OutgoingStatus?
	let onRetrySend: () -> Void
	let onDiscard: () -> Void
	let onRetryAgent: () -> Void
	/// Present only for a message the reader may edit (their latest).
	var onEdit: (() -> Void)?
	/// Reply to this message: quotes it above the composer; nil when there is no text to quote.
	var onQuote: (() -> Void)?
	var onAnswer: ([Int: [String]]) -> Void = { _ in }
	/// Said aloud in a live call rather than typed: marked with a small mic.
	var spoken = false
	@State private var selectingText = false
	@Environment(\.markdownInternalLinkInfo) private var linkInfo
	/// Present in the app; lets an agent's avatar and name open its page. Absent in previews and tests.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?

	/// Tail corner and every other corner (22, with a 6 tail).
	private static let radius = MaskinRadius.tile
	private static let tail = MaskinSpace.s3

	var body: some View {
		layout
		.sheet(isPresented: $selectingText) { SelectTextSheet(text: message.content) }
		.accessibilityElement(children: .contain)
		.accessibilityActions {
			if let onQuote { Button("Reply", action: onQuote) }
			if let onEdit { Button("Edit message", action: onEdit) }
			if !message.content.isEmpty {
				Button("Copy message") { Clipboard.copy(message.content) }
			}
			if message.isFailed {
				Button("Retry sending", action: onRetrySend)
				Button("Delete message", action: onDiscard)
			}
			if message.author == .agent, message.serverID != nil { Button("Try again", action: onRetryAgent) }
			if canReadAloud { Button(readAloudTitle, action: toggleReadAloud) }
		}
	}

	// MARK: Read aloud

	private var canReadAloud: Bool { !message.content.isEmpty && !message.isFailed }
	private var isReading: Bool { SpeechReader.shared.isSpeaking(message.id) }
	private var readAloudTitle: String { isReading ? "Stop reading" : "Read aloud" }

	private func toggleReadAloud() {
		if isReading {
			SpeechReader.shared.stop()
		} else {
			SpeechReader.shared.speak(markdown: message.content, id: message.id)
		}
	}

	// MARK: Message menu (long-press)

	/// Reply, Copy and the rest. Pin, reactions, Open in thread, Make it shorter and the feedback rows
	/// need server support that does not exist yet (see the handoff gaps); Try again is `/retry`.
	@ViewBuilder
	private var actions: some View {
		if let onQuote {
			Button(action: onQuote) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
		}
		if !message.content.isEmpty {
			Button {
				Clipboard.copy(message.content)
				MaskinHaptics.play(.selection)
			} label: {
				Label("Copy", systemImage: "doc.on.doc")
			}
			Button { selectingText = true } label: { Label("Select text", systemImage: "selection.pin.in.out") }
			ShareLink(item: message.content) { Label("Share", systemImage: "square.and.arrow.up") }
			if canReadAloud {
				Button(action: toggleReadAloud) {
					Label(readAloudTitle, systemImage: isReading ? "speaker.slash" : "speaker.wave.2")
				}
			}
		}
		if let onEdit {
			Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
		}
		if message.author == .agent, message.serverID != nil {
			Button(action: onRetryAgent) { Label("Try again", systemImage: "arrow.clockwise") }
		}
		if message.isFailed {
			Button(action: onRetrySend) { Label("Retry", systemImage: "arrow.clockwise") }
			Button(role: .destructive, action: onDiscard) { Label("Delete", systemImage: "trash") }
		}
	}

	// MARK: Layout

	@ViewBuilder
	private var layout: some View {
		if isOwn { ownBubble } else { column }
	}

	private var ownShape: UnevenRoundedRectangle {
		UnevenRoundedRectangle(
			topLeadingRadius: Self.radius, bottomLeadingRadius: Self.radius,
			bottomTrailingRadius: Self.tail, topTrailingRadius: Self.radius, style: .continuous)
	}

	private var theirShape: UnevenRoundedRectangle {
		UnevenRoundedRectangle(
			topLeadingRadius: Self.tail, bottomLeadingRadius: Self.radius,
			bottomTrailingRadius: Self.radius, topTrailingRadius: Self.radius, style: .continuous)
	}

	/// Yours, on the right: hugs a short message and stops at 82% of the column for a long one.
	private var ownBubble: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s2) {
			if hasOwnSurface {
				// A bare card or a lone emoji needs no bubble around it.
				VStack(alignment: .trailing, spacing: MaskinSpace.s1) { content }
					.environment(\.markdownHugsContent, true)
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) { content }
					.environment(\.markdownHugsContent, true)
					.environment(\.markdownOnInverse, true)
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s6)
					.background(MaskinSurface.inverse, in: ownShape)
					.overlay {
						if message.isFailed { ownShape.strokeBorder(MaskinColor.danger, lineWidth: 1.5) }
					}
					.contextPreview(ownShape)
					.contextMenu { actions }
			}
			MessageAttachments(attachments: message.attachments, alignment: .trailing)
			MentionLine(names: untaggedNames, isOwn: true)
			statusLine
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
		// 82% of the column: the rest is left empty on the leading side.
		.padding(.leading, MaskinSpace.s12 + MaskinSpace.s9)
	}

	/// The text with each tagged `@Name` marked so the renderer draws it bold.
	private var markdownText: String {
		mentions.isEmpty ? message.content : MentionText.markdown(message.content, mentions: mentions)
	}

	/// The "Mentioned X" caption only names people the words do not show; a tag in the text is
	/// already bold there, so repeating it below would say the same thing twice.
	private var untaggedNames: [String] {
		let names = mentions.isEmpty ? mentionNames : mentions.map(\.name)
		return MentionText.untagged(names, in: message.content)
	}

	/// Your message is only a link into Maskin (shown as a card) or only an emoji: no bubble.
	private var hasOwnSurface: Bool {
		if message.isEmojiOnly || callNote != nil { return true }
		if let link = MarkdownStandaloneLink.match(message.content), linkInfo?(link.url) != nil { return true }
		return false
	}

	private var column: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			if showsAuthor { header }
			if message.isEmojiOnly || callNote != nil {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) { content }
			} else {
				VStack(alignment: .leading, spacing: MaskinSpace.s1) { content }
					.padding(.horizontal, MaskinSpace.s9)
					.padding(.vertical, MaskinSpace.s7 + MaskinSpace.s1 / 2)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(MaskinSurface.card, in: theirShape)
					.contextPreview(theirShape)
					.contextMenu { actions }
			}
			if !message.questions.isEmpty {
				QuestionOptionsView(
					questions: message.questions, answers: questionAnswers, onSubmit: onAnswer)
			}
			MessageAttachments(attachments: message.attachments)
			MentionLine(names: untaggedNames, isOwn: isOwn)
			if message.isErrorReply {
				Button {
					onRetryAgent()
				} label: {
					Label("Try again", systemImage: "arrow.clockwise")
				}
				.buttonStyle(SecondaryActionButtonStyle())
				.fixedSize(horizontal: true, vertical: false)
				.padding(.top, MaskinSpace.s2)
			}
		}
		// Fill the row: nothing is reserved on the trailing side.
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// A 24pt avatar, the name (14pt semibold) and the time (12pt, quiet), 6pt above the bubble.
	private var header: some View {
		HStack(alignment: .center, spacing: MaskinSpace.s3) {
			authorLabel
			Spacer(minLength: 0)
			RelativeTime(message.createdAt, style: .clock)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.contentShape(Rectangle())
	}

	/// The avatar and name. An agent's open its page; a person's don't.
	@ViewBuilder
	private var authorLabel: some View {
		let label = HStack(spacing: MaskinSpace.s3) {
			ActorAvatar(
				name: message.actorName, kind: message.author == .agent ? .agent : .human,
				size: MaskinSpace.s12, seed: message.actorID)
				.accessibilityHidden(true)
			Text(message.actorName).maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink).lineLimit(1)
		}
		if message.author == .agent, let runtime {
			Button {
				runtime.openAgent(message.actorID)
			} label: {
				label.contentShape(Rectangle())
			}
			.buttonStyle(.maskinPressed)
			.accessibilityLabel("\(message.actorName), open agent")
		} else {
			label
		}
	}

	/// The summary an ended live call left here; nil for an ordinary message.
	private var callNote: LiveMeetingNote? { LiveMeetingNote.parse(message.content) }

	/// An emoji-only message is set large; it follows Dynamic Type like the text around it.
	@ScaledMetric(relativeTo: .largeTitle) private var emojiSize: CGFloat = 44

	/// Every message goes through the markdown renderer, as on the web. A person's line breaks are
	/// kept (they pressed Return); an agent's soft breaks are wrapped prose. "edited" ends the bubble
	/// at 60% strength.
	@ViewBuilder
	private var content: some View {
		let dimmed = message.isPending && !message.isFailed
		Group {
			if let callNote {
				LiveMeetingCard(note: callNote)
			} else if message.isEmojiOnly {
				Text(message.content).maskinSymbol(emojiSize)
			} else {
				MarkdownContent(markdownText, style: .chat, hardBreaks: message.author == .human)
			}
		}
		// Words and sentences can be selected and copied in place (long-press, then drag the handles);
		// the message menu on the bubble copies the whole message.
		.textSelection(.enabled)
		.opacity(dimmed ? 0.6 : 1)
		if message.editedAt != nil {
			Text("edited").maskinText(.caption).opacity(0.6)
		}
		if spoken {
			Label("LIVE", systemImage: "mic.fill").maskinText(.microLabel).opacity(0.6)
				.accessibilityLabel("Spoken in a live call")
		}
	}

	/// Where your message stands, right-aligned under it: "9:41 AM · Read by Forge", "Sent",
	/// "Sending…", or in red "Not sent · Tap to retry".
	@ViewBuilder
	private var statusLine: some View {
		if let outgoing {
			Group {
				if case .failed(let reason) = outgoing {
					Button(action: onRetrySend) {
						Text(outgoing.text()).fontWeight(.semibold).foregroundStyle(MaskinColor.danger)
							.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s5)
							.contentShape(Rectangle())
					}
					.buttonStyle(.maskinPressed)
					.accessibilityHint(reason)
				} else {
					HStack(spacing: MaskinSpace.s2) {
						if case .queued = outgoing { Image(systemName: "clock").accessibilityHidden(true) }
						Text(outgoing.text(time: clockTime)).foregroundStyle(MaskinColor.ink5)
					}
				}
			}
			.maskinText(.caption)
			.frame(maxWidth: .infinity, alignment: .trailing)
		}
	}

	/// "9:41 AM" for the status line.
	private var clockTime: String? {
		guard let date = message.createdAt else { return nil }
		return date.formatted(date: .omitted, time: .shortened)
	}
}

extension View {
	/// The shape the long-press menu lifts (iOS); elsewhere the view as it is.
	func contextPreview<S: Shape>(_ shape: S) -> some View {
		#if os(iOS)
		contentShape(.contextMenuPreview, shape)
		#else
		self
		#endif
	}
}

enum Clipboard {
	static func copy(_ string: String) {
		#if canImport(UIKit)
		UIPasteboard.general.string = string
		#elseif canImport(AppKit)
		NSPasteboard.general.clearContents()
		NSPasteboard.general.setString(string, forType: .string)
		#endif
	}
}

/// The agent is composing a reply (before any activity shows): its name above three pulsing 7pt dots
/// in an agent-shaped bubble. Dots always mean composing; work gets equalizer bars (`WorkingBars`).
struct TypingBubble: View {
	let agent: ChatParticipant
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			HStack(spacing: MaskinSpace.s3) {
				ActorAvatar(name: agent.name, kind: .agent, size: MaskinSpace.s12, seed: agent.id)
					.accessibilityHidden(true)
				Text(agent.name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
			}
			dots
				.padding(.horizontal, MaskinSpace.s10 - MaskinSpace.s1)
				.padding(.vertical, MaskinSpace.s9)
				.background(
					MaskinSurface.card,
					in: UnevenRoundedRectangle(
						topLeadingRadius: MaskinSpace.s3, bottomLeadingRadius: MaskinRadius.tile,
						bottomTrailingRadius: MaskinRadius.tile, topTrailingRadius: MaskinRadius.tile,
						style: .continuous))
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .ignore)
		.accessibilityLabel("\(agent.name) is typing")
	}

	/// Three 7pt dots, pulsing over 1s and staggered by 0.2s.
	private var dots: some View {
		HStack(spacing: MaskinSpace.s2) {
			ForEach(0..<3, id: \.self) { i in
				Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s3 + MaskinSpace.s1 / 2, height: MaskinSpace.s3 + MaskinSpace.s1 / 2)
					.phaseAnimator([0.3, 1.0], trigger: reduceMotion) { view, phase in
						view.opacity(reduceMotion ? 0.7 : phase)
					} animation: { _ in
						.easeInOut(duration: 0.5).delay(Double(i) * 0.2)
					}
			}
		}
	}
}

/// Three small equalizer bars in signal green: "working on a task" (live activity, Flows rows,
/// handoff cards). Still under Reduce Motion.
struct WorkingBars: View {
	var body: some View {
		VoiceWaveform(bars: 3, height: MaskinSpace.s8, barWidth: MaskinSpace.s1, tint: MaskinColor.sig)
			.fixedSize()
	}
}

/// An agent that paused (or whose run was suspended): offer to continue it.
struct ResumeBanner: View {
	let agent: ChatParticipant
	let onResume: () -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s6) {
			Image(systemName: "pause.circle.fill").foregroundStyle(MaskinColor.ink4).accessibilityHidden(true)
			Text("\(agent.name) is paused").maskinText(.subhead).foregroundStyle(MaskinColor.ink2)
			Spacer(minLength: 0)
			Button(action: onResume) {
				Text("Resume").maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.horizontal, MaskinSpace.s8)
					.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s3)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.accessibilityLabel("Resume \(agent.name)")
		}
		.padding(.horizontal, MaskinSpace.s8)
		.padding(.vertical, MaskinSpace.s4)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}
