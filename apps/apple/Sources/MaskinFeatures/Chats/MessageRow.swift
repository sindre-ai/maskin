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
	/// Colours the label and rules (the "new messages" marker); nil keeps the quiet default.
	var tint: Color?
	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			line
			Text(label).maskinText(.caption).foregroundStyle(tint ?? MaskinColor.ink4).lineLimit(1)
			line
		}
		.padding(.vertical, MaskinSpace.s4)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	private var line: some View {
		Rectangle().fill(tint?.opacity(0.35) ?? MaskinSurface.line).frame(height: 1)
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
			.foregroundStyle(MaskinColor.accentFgStrong)
			.accessibilityElement(children: .combine)
		}
	}
}

private struct MessageHeightKey: PreferenceKey {
	static let defaultValue: CGFloat = 0
	static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// Measurements shared by everything that sits in the thread's message column, so avatars, text,
/// activity traces and the working indicator all line up on the same left edge.
enum ThreadMetrics {
	/// Avatar diameter, and so the width of the left gutter.
	static let avatar = MaskinSpace.s14 + MaskinSpace.s2
	static let gutterGap = MaskinSpace.s6
	/// Where message text starts: past the gutter.
	static var textIndent: CGFloat { avatar + gutterGap }
}

/// One message, laid out the same for you and for everyone else: an avatar in a left gutter on the
/// first message of a run, the name, an agent tag and the time on one line, and the text beneath,
/// full width, with no bubbles. Follow-up messages from the same author keep the gutter empty and
/// show their time when tapped. People's and agents' words are both rendered as markdown. An
/// agent's question renders as tappable options under its text.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	var mentionNames: [String] = []
	/// What the human picked, once this question has been answered.
	var questionAnswers: [ChatQuestionAnswer.Answer]?
	let onRetrySend: () -> Void
	let onDiscard: () -> Void
	let onRetryAgent: () -> Void
	/// Present only for a message the reader may edit.
	var onEdit: (() -> Void)?
	var onAnswer: ([Int: [String]]) -> Void = { _ in }
	@State private var selectingText = false
	/// Tapping a row shows its time (in the gutter, for a follow-up) and an action bar: Copy for the
	/// whole message first. Text itself is selectable in place, so long-press there picks words.
	@State private var showsActions = false
	@State private var copied = false
	/// The message's full height once laid out, and whether the reader has opened a long one.
	@State private var fullHeight: CGFloat = 0
	@State private var expanded = false

	var body: some View {
		HStack(alignment: .top, spacing: ThreadMetrics.gutterGap) {
			gutter
			column
		}
		.contentShape(Rectangle())
		.onTapGesture {
			withAnimation(MaskinMotion.quick) { showsActions.toggle() }
		}
		.sheet(isPresented: $selectingText) { SelectTextSheet(text: message.content) }
		.accessibilityElement(children: .contain)
		.accessibilityActions {
			if let onEdit { Button("Edit message", action: onEdit) }
			if !message.content.isEmpty {
				Button("Copy message") { Clipboard.copy(message.content) }
			}
			if message.isFailed {
				Button("Retry sending", action: onRetrySend)
				Button("Delete message", action: onDiscard)
			}
			if message.isErrorReply { Button("Try again", action: onRetryAgent) }
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

	// MARK: Actions

	@ViewBuilder
	private var actions: some View {
		if let onEdit {
			Button(action: onEdit) { Label("Edit", systemImage: "pencil") }
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
		if message.isFailed {
			Button(action: onRetrySend) { Label("Retry", systemImage: "arrow.clockwise") }
			Button(role: .destructive, action: onDiscard) { Label("Delete", systemImage: "trash") }
		}
		if message.isErrorReply {
			Button(action: onRetryAgent) { Label("Try again", systemImage: "arrow.clockwise") }
		}
	}

	// MARK: Layout

	/// The avatar on the first message of a run; for a follow-up, empty until tapped, then the time.
	private var gutter: some View {
		Group {
			if showsAuthor {
				ActorAvatar(
					name: message.actorName, kind: message.author == .agent ? .agent : .human,
					size: ThreadMetrics.avatar, seed: message.actorID)
					.accessibilityHidden(true)
					.contentShape(Rectangle())
					.contextMenu { actions }
			} else if showsActions {
				RelativeTime(message.createdAt, style: .clock)
					.maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
					.padding(.top, MaskinSpace.s2)
					.transition(.opacity)
			} else {
				// Fixed height: a bare `Color` fills whatever height it is offered and would stretch the row.
				Color.clear.frame(height: 0)
			}
		}
		.frame(width: ThreadMetrics.avatar, alignment: showsAuthor ? .center : .trailing)
	}

	private var column: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s1) {
			if showsAuthor { header }
			content
			if !message.questions.isEmpty {
				QuestionOptionsView(
					questions: message.questions, answers: questionAnswers, onSubmit: onAnswer)
			}
			MessageAttachments(attachments: message.attachments)
			if showsActions, !message.content.isEmpty || onEdit != nil { actionBar }
			MentionLine(names: mentionNames, isOwn: isOwn)
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
			if isOwn { statusLine }
		}
		// Fill the row: nothing is reserved on the trailing side.
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// Name, an agent tag and the time, on one baseline. Long-press for message actions.
	private var header: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s3) {
			Text(message.actorName).maskinText(.subhead).fontWeight(.semibold)
				.foregroundStyle(MaskinColor.ink).lineLimit(1)
			if message.author == .agent {
				Text("AGENT").maskinText(.microLabel).foregroundStyle(MaskinColor.ink5)
					.accessibilityHidden(true)
			}
			RelativeTime(message.createdAt, style: .clock)
				.maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
		.contentShape(Rectangle())
		.contextMenu { actions }
	}

	// MARK: Action bar

	private func copyWholeMessage() {
		Clipboard.copy(message.content)
		MaskinHaptics.play(.success)
		copied = true
		Task {
			try? await Task.sleep(for: .seconds(1.6))
			copied = false
		}
	}

	/// What a tap on the row offers: copy the whole message, select across paragraphs, share, edit.
	private var actionBar: some View {
		HStack(spacing: MaskinSpace.s4) {
			if !message.content.isEmpty {
				Button(action: copyWholeMessage) {
					barLabel(copied ? "Copied" : "Copy", copied ? "checkmark" : "doc.on.doc")
				}
				.buttonStyle(.plain)
				Button { selectingText = true } label: { barLabel("Select", "selection.pin.in.out") }
					.buttonStyle(.plain)
				ShareLink(item: message.content) { barLabel("Share", "square.and.arrow.up") }
					.buttonStyle(.plain)
			}
			if let onEdit {
				Button(action: onEdit) { barLabel("Edit", "pencil") }.buttonStyle(.plain)
			}
		}
		.padding(.top, MaskinSpace.s2)
		.transition(.opacity)
	}

	private func barLabel(_ title: String, _ symbol: String) -> some View {
		Label(title, systemImage: symbol)
			.maskinText(.caption).fontWeight(.semibold)
			.foregroundStyle(MaskinColor.ink3)
			.padding(.horizontal, MaskinSpace.s6)
			.frame(minHeight: MaskinSpace.s14 + MaskinSpace.s2)
			.background(MaskinSurface.fill, in: Capsule())
			.contentShape(Capsule())
	}

	private static let emojiSize: CGFloat = 44
	/// A long message shows this much, then "Show more". It only collapses if opening it would reveal
	/// at least `collapseSlack` more, so a message a few lines over the line is never hidden.
	private static let collapsedHeight: CGFloat = 300
	private static let collapseSlack: CGFloat = 120

	/// Until the message has been measured, a long text is assumed tall, so it starts collapsed
	/// instead of drawing full height and then shrinking.
	private var isCollapsible: Bool {
		guard !message.isEmojiOnly, message.questions.isEmpty else { return false }
		if fullHeight > 0 { return fullHeight > Self.collapsedHeight + Self.collapseSlack }
		return message.content.count > 900 || message.content.filter { $0 == "\n" }.count > 16
	}

	private var isCollapsed: Bool { isCollapsible && !expanded }

	/// Every message goes through the markdown renderer, as on the web. A person's line breaks are
	/// kept (they pressed Return); an agent's soft breaks are wrapped prose. A long-press opens the
	/// message menu; "Select text" there covers picking words.
	@ViewBuilder
	private var content: some View {
		let dimmed = message.isPending && !message.isFailed
		Group {
			if message.isEmojiOnly {
				Text(message.content).font(.system(size: Self.emojiSize))
			} else {
				MarkdownContent(message.content, style: .chat, hardBreaks: message.author == .human)
			}
		}
		// Words and sentences can be selected and copied in place (long-press, then drag the handles).
		// The whole-message actions live on the row's tap bar and the avatar/name long-press menu.
		.textSelection(.enabled)
		// Measured at its natural height (not squeezed by the frame below), then cropped.
		.fixedSize(horizontal: false, vertical: true)
		.background(
			GeometryReader { proxy in
				Color.clear.preference(key: MessageHeightKey.self, value: proxy.size.height)
			}
		)
		.onPreferenceChange(MessageHeightKey.self) { fullHeight = $0 }
		.frame(maxHeight: isCollapsed ? Self.collapsedHeight : nil, alignment: .top)
		.clipped()
		.overlay(alignment: .bottom) {
			if isCollapsed {
				LinearGradient(
					colors: [MaskinSurface.grouped.opacity(0), MaskinSurface.grouped], startPoint: .top,
					endPoint: .bottom
				)
				.frame(height: MaskinSpace.s14 * 2)
				.allowsHitTesting(false)
			}
		}
		.opacity(dimmed ? 0.6 : 1)
		if isCollapsible {
			Button {
				withAnimation(MaskinMotion.standard) { expanded.toggle() }
				MaskinHaptics.play(.selection)
			} label: {
				Label(expanded ? "Show less" : "Show more", systemImage: expanded ? "chevron.up" : "chevron.down")
					.maskinText(.subhead).fontWeight(.semibold)
					.foregroundStyle(MaskinColor.accentStrong)
					.padding(.vertical, MaskinSpace.s3)
					.contentShape(Rectangle())
			}
			.buttonStyle(.plain)
			.accessibilityLabel(expanded ? "Show less of this message" : "Show the full message")
		}
		if message.editedAt != nil {
			Text("edited").maskinText(.caption).foregroundStyle(MaskinColor.ink5)
		}
	}

	/// Where your own message stands: on its way, held back, or not sent.
	@ViewBuilder
	private var statusLine: some View {
		switch message.status {
		case .sent:
			EmptyView()
		case .sending:
			Text("Sending…").maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		case .waiting(let reason):
			HStack(spacing: MaskinSpace.s2) {
				Image(systemName: "clock").accessibilityHidden(true)
				Text("Queued · \(reason)")
			}
			.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
		case .failed(let reason):
			VStack(alignment: .leading, spacing: 0) {
				HStack(spacing: MaskinSpace.s4) {
					Image(systemName: "exclamationmark.circle.fill").foregroundStyle(MaskinColor.danger)
						.accessibilityHidden(true)
					Text("Not sent").foregroundStyle(MaskinColor.danger)
					Button("Retry", action: onRetrySend).buttonStyle(.plain)
						.foregroundStyle(MaskinColor.accentFgStrong)
						.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
						.accessibilityHint(reason)
					Button("Delete", role: .destructive, action: onDiscard).buttonStyle(.plain)
						.foregroundStyle(MaskinColor.ink4)
						.frame(minWidth: MaskinSpace.touchMin, minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				Text(reason).maskinText(.caption).foregroundStyle(MaskinColor.ink4)
			}
			.maskinText(.caption)
		}
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

/// "Relay is working · Reading the brief" with animated dots (static under Reduce Motion) and,
/// for a live run, a Stop control.
struct WorkingIndicator: View {
	let agent: ChatParticipant
	var activity: String?
	var onStop: (() -> Void)?
	@Environment(\.accessibilityReduceMotion) private var reduceMotion

	var body: some View {
		HStack(spacing: ThreadMetrics.gutterGap) {
			ActorAvatar(name: agent.name, kind: .agent, size: ThreadMetrics.avatar, seed: agent.id, working: true)
			VStack(alignment: .leading, spacing: 0) {
				HStack(spacing: MaskinSpace.s4) {
					Text("\(agent.name) is working").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					dots
				}
				if let activity, !activity.isEmpty {
					Text(activity).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(2)
				}
			}
			Spacer(minLength: 0)
			if let onStop {
				Button(action: onStop) {
					Text("Stop").maskinText(.subhead).foregroundStyle(MaskinColor.ink3)
						.padding(.horizontal, MaskinSpace.s7)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Stop \(agent.name)")
			}
		}
		.accessibilityElement(children: .combine)
	}

	private var dots: some View {
		HStack(spacing: MaskinSpace.s1 + MaskinSpace.s1) {
			ForEach(0..<3, id: \.self) { i in
				Circle().fill(MaskinColor.ink5).frame(width: MaskinSpace.s3, height: MaskinSpace.s3)
					.phaseAnimator([0.35, 1.0], trigger: reduceMotion) { view, phase in
						view.opacity(reduceMotion ? 0.7 : phase)
					} animation: { _ in
						.easeInOut(duration: 0.6).delay(Double(i) * 0.15)
					}
			}
		}
		.accessibilityHidden(true)
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
			.buttonStyle(.plain)
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
