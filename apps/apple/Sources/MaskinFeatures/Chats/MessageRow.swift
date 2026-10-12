import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

/// A divider line (spec 7 §3): the label in mono 11pt between two 1pt rules. Day labels are `ink5`
/// on `line` rules; the NEW marker is `sigInk` on `sigHi` rules. A system line ("Sebastian added
/// CPO") is centred grey text with no rules.
struct ThreadDivider: View {
	let label: String
	/// Colours the label (the NEW marker); nil keeps the quiet day style.
	var tint: Color?
	var ruleTint: Color?
	/// False for a system line: centred text with no rules.
	var ruled = true

	var body: some View {
		HStack(spacing: MaskinSpace.s5) {
			if ruled { line }
			if ruled {
				Text(label).font(ChatType.mono11).tracking(ChatType.mono11Tracking)
					.foregroundStyle(tint ?? MaskinColor.ink5).lineLimit(1)
			} else {
				Text(label).maskinText(.caption).foregroundStyle(MaskinColor.inkPlaceholder).lineLimit(2)
					.multilineTextAlignment(.center)
					.frame(maxWidth: .infinity)
			}
			if ruled { line }
		}
		.padding(.vertical, MaskinSpace.s3)
		.accessibilityElement(children: .combine)
		.accessibilityAddTraits(.isHeader)
	}

	private var line: some View {
		Rectangle().fill(ruleTint ?? MaskinSurface.line).frame(height: 1)
	}

	/// The NEW divider above the first unread message.
	static func unread(count: Int) -> ThreadDivider {
		ThreadDivider(label: "NEW", tint: MaskinColor.sigInk, ruleTint: MaskinColor.sigHi)
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

/// One message as a spec 7 bubble. Theirs: a `card` bubble with the tail top-left, full width,
/// with the 24pt avatar + name + time header on the first of a run (an agent's opens its page);
/// yours: an ink bubble with the tail bottom-right, at most 82% wide, with the status line under
/// your newest one. A quote and any attachments sit at the top of the bubble; `edited` sits inside
/// it. Long-press opens the actions with a preview; swiping right starts a reply. An agent's
/// question renders as a decision card under its bubble. Tagged `@Name`s are bold in the text.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	var mentionNames: [String] = []
	/// The tagged people (id and full name). Their `@Name` in the text is shown bold.
	var mentions: [(id: String, name: String)] = []
	/// What the human picked, once this question has been answered.
	var questionAnswers: [ChatQuestionAnswer.Answer]?
	/// Set only on your newest message.
	var sendStatus: MessageSendStatus?
	var messageOverride = MessageOverride()
	var isPinned = false
	var versionsLocked = false
	/// The agent is running right now (header avatar ring).
	var working = false
	var actions = MessageMenuActions()
	var onRetrySend: () -> Void = {}
	/// Swipe right (and the menu's Reply) start a reply; nil when there is nothing to quote.
	var onReply: (() -> Void)?
	var onAnswer: ([Int: [String]]) -> Void = { _ in }
	var onSelectVersion: (Int) -> Void = { _ in }
	@Environment(\.markdownInternalLinkInfo) private var linkInfo
	/// Present in the app; lets an agent's avatar and name open its page. Absent in previews and tests.
	@Environment(AppRuntime.self) private var runtime: AppRuntime?
	@State private var rowWidth: CGFloat = 0

	/// An emoji-only message is set large; it follows Dynamic Type like the text around it.
	@ScaledMetric(relativeTo: .largeTitle) private var emojiSize: CGFloat = 44

	var body: some View {
		Group {
			if isOwn { own } else { theirs }
		}
		.onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { rowWidth = $0 }
		.accessibilityElement(children: .contain)
		.accessibilityActions {
			ForEach(Array(zip(actions.titles.indices, actions.titles)), id: \.0) { _, title in
				Button(title) { perform(title) }
			}
		}
	}

	private func perform(_ title: String) {
		switch title {
		case "Reply": actions.onReply?()
		case "Copy": actions.onCopy?()
		case "Pin", "Unpin": actions.onPin?()
		case "Edit": actions.onEdit?()
		case "Try again": actions.onTryAgain?()
		case "Make it shorter": actions.onShorter?()
		case "Good answer": actions.onGoodAnswer?()
		case "Not right": actions.onNotRight?()
		case "Retry": actions.onRetrySend?()
		case "Delete": actions.onDiscard?()
		default: actions.onReadAloud?()
		}
	}

	private var shownText: String { messageOverride.text(original: message.content) }
	private var quote: QuotedReply? { QuotedReply.parse(shownText) }
	private var bodyText: String { quote?.body ?? shownText }

	/// The body with each tagged `@Name` marked so the renderer draws it bold.
	private var markdownText: String {
		mentions.isEmpty ? bodyText : MentionText.markdown(bodyText, mentions: mentions)
	}

	/// The "Mentioned X" caption only names people the words do not show; a tag in the text is
	/// already bold there, so repeating it below would say the same thing twice.
	private var untaggedNames: [String] {
		let names = mentions.isEmpty ? mentionNames : mentions.map(\.name)
		return MentionText.untagged(names, in: message.content)
	}

	// MARK: Mine

	/// Your message is only a link into Maskin (shown as a card) or only an emoji: no bubble.
	private var hasOwnSurface: Bool {
		if message.isEmojiOnly { return true }
		if let link = MarkdownStandaloneLink.match(message.content), linkInfo?(link.url) != nil { return true }
		return false
	}

	private var own: some View {
		VStack(alignment: .trailing, spacing: MaskinSpace.s2) {
			Group {
				if hasOwnSurface {
					VStack(alignment: .trailing, spacing: MaskinSpace.s1) {
						if message.isEmojiOnly {
							Text(message.content).maskinSymbol(emojiSize)
						} else {
							MarkdownContent(message.content, style: .chat, hardBreaks: true)
						}
					}
					.environment(\.markdownHugsContent, true)
				} else {
					VStack(alignment: .leading, spacing: MaskinSpace.s3) {
						if let quote { QuoteBlock(author: quote.author, text: quote.text, onInverse: true) }
						MessageAttachments(attachments: message.attachments)
						if !bodyText.isEmpty {
							HStack(alignment: .lastTextBaseline, spacing: MaskinSpace.s3) {
								MarkdownContent(markdownText, style: .chat, hardBreaks: true)
									.textSelection(.enabled)
								if message.editedAt != nil { EditedMark() }
							}
						}
					}
					.environment(\.markdownHugsContent, true)
					.environment(\.markdownOnInverse, true)
					.foregroundStyle(MaskinSurface.onInverse)
					.padding(.vertical, BubbleShape.myVertical)
					.padding(.horizontal, BubbleShape.horizontal)
					.background(MaskinSurface.inverse, in: BubbleShape.mine)
					.opacity(message.isPending && !message.isFailed ? 0.75 : 1)
				}
			}
			.frame(maxWidth: rowWidth > 0 ? rowWidth * BubbleShape.myMaxWidthFraction : nil, alignment: .trailing)
			.swipeToReply(onReply)
			.messageContextMenu(message, isOwn: true, actions: actions)
			MentionLine(names: untaggedNames, isOwn: true)
			if let sendStatus {
				MessageStatusLine(status: sendStatus, time: message.createdAt, onRetry: onRetrySend)
			}
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
	}

	// MARK: Theirs

	private var theirs: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			if showsAuthor {
				MessageHeader(
					name: message.actorName, kind: message.author, seed: message.actorID, time: message.createdAt,
					working: working,
					onOpen: message.author == .agent && runtime != nil ? { runtime?.openAgent(message.actorID) } : nil)
			}
			Group {
				if message.isEmojiOnly {
					Text(message.content).maskinSymbol(emojiSize)
				} else {
					VStack(alignment: .leading, spacing: MaskinSpace.s3) {
						if let quote { QuoteBlock(author: quote.author, text: quote.text) }
						MessageAttachments(attachments: message.attachments)
						if !bodyText.isEmpty {
							MarkdownContent(markdownText, style: .chat, hardBreaks: message.author == .human)
								.textSelection(.enabled)
						}
						if message.editedAt != nil { EditedMark().foregroundStyle(MaskinColor.ink2) }
						if message.isErrorReply, let onTryAgain = actions.onTryAgain {
							Button(action: onTryAgain) { Label("Try again", systemImage: "arrow.clockwise") }
								.buttonStyle(SecondaryActionButtonStyle())
								.fixedSize(horizontal: true, vertical: false)
								.padding(.top, MaskinSpace.s2)
						}
					}
					.foregroundStyle(MaskinColor.ink2)
					.padding(.vertical, BubbleShape.theirVertical)
					.padding(.horizontal, BubbleShape.horizontal)
					.frame(maxWidth: .infinity, alignment: .leading)
					.background(MaskinSurface.card, in: BubbleShape.agent)
				}
			}
			.swipeToReply(onReply)
			.messageContextMenu(message, isOwn: false, actions: actions)
			if !message.questions.isEmpty {
				QuestionOptionsView(questions: message.questions, answers: questionAnswers, onSubmit: onAnswer)
			}
			footer
			MentionLine(names: untaggedNames, isOwn: false)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	/// Versions pager and local feedback under an agent bubble.
	@ViewBuilder
	private var footer: some View {
		if messageOverride.hasVersions || messageOverride.feedback != nil {
			HStack(spacing: MaskinSpace.s5) {
				if messageOverride.hasVersions {
					VersionPager(
						index: messageOverride.versionIndex, count: messageOverride.versions.count, locked: versionsLocked,
						onStep: onSelectVersion)
				}
				if let feedback = messageOverride.feedback {
					Label(
						feedback == .good ? "Good answer" : "Not right",
						systemImage: feedback == .good ? "hand.thumbsup.fill" : "hand.thumbsdown.fill")
						.maskinText(.caption)
						.foregroundStyle(MaskinColor.ink5)
				}
			}
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

/// "Relay is working on it" with the equaliser bars (never dots: dots mean typing), and the
/// session's one-line activity under it. Used while an agent runs without a step trace.
struct WorkingIndicator: View {
	let agent: ChatParticipant
	var activity: String?

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			ActorAvatar(name: agent.name, kind: .agent, size: MaskinSpace.s12, seed: agent.id, working: true)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				HStack(spacing: MaskinSpace.s4) {
					Text(agent.name).maskinText(.subhead).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
					EqualiserBars()
					Text("is working on it").maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
				}
				if let activity, !activity.isEmpty {
					Text(activity).maskinText(.caption).foregroundStyle(MaskinColor.ink5).lineLimit(2)
				}
			}
			Spacer(minLength: 0)
		}
		.accessibilityElement(children: .combine)
		.accessibilityLabel("\(agent.name) is working on it")
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
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card2xl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}
