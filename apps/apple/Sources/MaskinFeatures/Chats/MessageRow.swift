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

/// A system line in the chat ("Sales Rep sent the connection request"): a small teal marker, the
/// words, and the time on the right. Not a bubble and not a divider.
struct SystemLine: View {
	let message: ChatMessage

	var body: some View {
		HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
			RoundedRectangle(cornerRadius: MaskinSpace.s1, style: .continuous)
				.fill(MaskinColor.sig)
				.frame(width: MaskinSpace.s3 + 1, height: MaskinSpace.s3 + 1)
				.accessibilityHidden(true)
			Text(message.content)
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink5)
				.frame(maxWidth: .infinity, alignment: .leading)
			if let time = message.createdAt {
				RelativeTime(time, style: .clock)
					.font(MaskinTypeface.sans(MaskinFontSize.t11, relativeTo: .caption2))
					.foregroundStyle(MaskinColor.inkPlaceholder)
			}
		}
		.padding(.vertical, MaskinSpace.s4)
		.accessibilityElement(children: .combine)
	}
}

/// Your tagged people under your message, each with where they stand: Working, Replied, Waiting for Sam.
struct MentionStateLine: View {
	let chips: [MentionStateChip]

	var body: some View {
		if !chips.isEmpty {
			ChipFlow {
				ForEach(chips, id: \.id) { (chip: MentionStateChip) in
					Text(chip.label)
						.maskinText(.caption).fontWeight(.semibold)
						.foregroundStyle(chip.state == .working ? MaskinColor.sigInk : MaskinColor.ink4)
						.padding(.horizontal, MaskinSpace.s5)
						.frame(minHeight: MaskinSpace.s12 + MaskinSpace.s2)
						.background(MaskinSurface.fill, in: Capsule())
				}
			}
			.frame(maxWidth: .infinity, alignment: .trailing)
			.accessibilityElement(children: .combine)
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
/// your newest one. A quote sits at the top of the bubble and `edited` inside it; pictures and
/// files sit outside it, above, and a message with no words has no bubble. Long-press opens the actions with a preview; swiping right starts a reply. An agent's
/// question renders as a decision card under its bubble. Tagged `@Name`s are bold in the text.
struct MessageRow: View {
	let message: ChatMessage
	let isOwn: Bool
	let showsAuthor: Bool
	var mentionNames: [String] = []
	/// Where each tagged person stands; shown under your own message in place of the caption.
	var mentionChips: [MentionStateChip] = []
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
	/// The thread under this message, when it has replies; the pill under the bubble opens it.
	var threadSummary: ThreadSummary?
	var onOpenThread: () -> Void = {}
	/// Tap on an emoji chip under the bubble (add or take back).
	var onToggleReaction: (String) -> Void = { _ in }
	var onAnswer: ([Int: [String]]) -> Void = { _ in }
	/// The person's answer to a Keychain card (allow or not now), posted into the chat.
	var onKeychainReply: (String, ChatSendMetadata) -> Void = { _, _ in }
	/// An intro's send step tapped: send its words, noting which step it was.
	/// Nil where the screen cannot send a step (a thread), so the buttons are not drawn at all rather
	/// than drawn and dead.
	var onSendStep: ((_ prompt: String, _ introMessageID: Int, _ index: Int) -> Void)?
	/// An intro's fill step tapped: put its prompt in the message box.
	var onFillStep: ((String) -> Void)?
	/// The steps are on offer only until a person has written after the intro.
	var introStepsOpen = true
	/// How a person already answered an agent's card in this message (read from the chat).
	var cardOutcome: ChatCardAnswer.Outcome?
	/// The agents in this chat, who may use a credential saved from a Keychain card.
	var chatAgents: [ChatParticipant] = []
	var onSelectVersion: (Int) -> Void = { _ in }
	/// A person approved a draft shown as a card in this message: its title and the text approved.
	/// The thread tells the agent.
	var onApprovedDraft: (_ title: String?, _ body: String) -> Void = { _, _ in }
	/// For each target the conversation links to, the message that links it first
	/// (`LinkedConversationItems.firstMentions`): an object is a card there and a link in later
	/// messages. Empty where the conversation is not known (previews, a thread of replies).
	var cardOwners: [String: String] = [:]
	@Environment(\.linkedItems) private var linked
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
		case "Reply in thread": actions.onThread?()
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

	private var shownText: String { messageOverride.text(original: message.contentWithoutIntroTail) }
	private var quote: QuotedReply? { QuotedReply.parse(shownText) }
	private var bodyText: String { quote?.body ?? shownText }

	/// The body with each tagged `@Name` marked so the renderer draws it bold.
	private var markdownText: String {
		mentions.isEmpty ? bodyText : MentionText.markdown(bodyText, mentions: mentions)
	}

	// MARK: Linked cards

	/// Objects, drafts and pages a message links to are drawn as cards: in place where the link
	/// stands alone, under the bubble where it sits in a sentence. Your own words get object cards
	/// only. At most ten objects are looked up; the links past that stay plain.
	private var linkedTargets: [LinkedTarget] {
		guard linked != nil, message.kind == "message", !message.isEmojiOnly,
			LinkedConversationItems.mayLink(bodyText)
		else { return [] }
		let found = LinkedTarget.extract(from: bodyText)
		return LinkedMessageLayout.lookupTargets(isOwn ? found.filter { $0.kind == .object } : found)
	}

	/// What to draw for the text, or nil when no link in it is a card (the text then renders as it
	/// always did, folding included). At most three cards, across every kind; an object that is a
	/// card in an earlier message of the conversation stays a link here.
	private func linkedLayout(for targets: [LinkedTarget]) -> (parts: [LinkedMessagePart], appended: [LinkedTarget])? {
		guard let linked, !targets.isEmpty else { return nil }
		let looked = Set(targets.map(\.key))
		let ownMessage = self.isOwn
		let isCard: (LinkedTarget) -> Bool = { target in
			guard looked.contains(target.key), linked.showsCard(target) else { return false }
			// The approval card is for what an agent wrote; a draft you link is a link.
			if ownMessage, case .draft? = linked.item(for: target) { return false }
			return true
		}
		let skipping = Set(
			targets.filter { target in
				guard target.kind != .file, let owner = cardOwners[target.key], owner != message.id else { return false }
				if case .draft? = linked.item(for: target) { return false }
				return true
			}.map(\.key))
		let parts = LinkedMessageLayout.parts(
			segments: LinkedMessageSplitter.split(bodyText), isCard: isCard, limit: LinkedMessageLayout.maxCardsPerMessage,
			skipping: skipping)
		let appended = LinkedMessageLayout.appended(message: bodyText, parts: parts, isCard: isCard, skipping: skipping)
		let hasCardInPlace = parts.contains { if case .card = $0 { true } else { false } }
		return hasCardInPlace || !appended.isEmpty ? (parts, appended) : nil
	}

	/// How a stand-alone link in the text is drawn. A message that places its own cards draws the
	/// object and file links it has no card for (past the three, or already a card above) as inline
	/// links; the thin card stays for the rest.
	private func standaloneStyle(placingCards: Bool) -> @MainActor (URL, String?) -> MarkdownStandaloneLinkStyle {
		{ url, _ in
			let target = LinkedTarget.parse(href: url.absoluteString)
			if placingCards, target != nil { return .inline }
			// A person at an agent address is a plain link, not the thin card of an agent.
			if let target, target.kind == .agent, linked?.state(for: target) == .unavailable { return .inline }
			return .simple
		}
	}

	/// Past ten object links the rest are not looked up, so they read as plain links: the in-app
	/// link info (which would look them up) is withheld for them.
	private func cappedLinkInfo(_ targets: [LinkedTarget]) -> (@MainActor (URL) -> MarkdownLinkInfo?)? {
		guard let base = linkInfo,
			targets.filter({ $0.kind != .file }).count == LinkedMessageLayout.maxObjectLookupsPerMessage
		else { return linkInfo }
		let looked = Set(targets.map(\.key))
		return { url in
			if let target = LinkedTarget.parse(href: url.absoluteString), target.kind != .file, !looked.contains(target.key) {
				return nil
			}
			return base(url)
		}
	}

	private func linkedBody(_ parts: [LinkedMessagePart]) -> some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ForEach(parts.enumerated().map { (id: $1.stableID(at: $0), part: $1) }, id: \.id) { entry in
				switch entry.part {
				case .markdown(let text):
					MarkdownContent(
						mentions.isEmpty ? text : MentionText.markdown(text, mentions: mentions), style: .chat,
						hardBreaks: message.author == .human
					)
					.textSelection(.enabled)
				case .card(let target):
					LinkedTargetCard(target: target, onApproved: onApprovedDraft)
				}
			}
		}
		.environment(\.linkedInBubble, true)
	}

	/// The "Mentioned X" caption only names people the words do not show; a tag in the text is
	/// already bold there, so repeating it below would say the same thing twice.
	private var untaggedNames: [String] {
		let names = mentions.isEmpty ? mentionNames : mentions.map(\.name)
		return MentionText.untagged(names, in: message.content)
	}

	// MARK: Mine

	/// Your message is only a link into Maskin (shown as a card) or only an emoji: no bubble.
	private func hasOwnSurface(placingCards: Bool) -> Bool {
		if message.isEmojiOnly { return true }
		// A link the app cannot draw as a card (a chat, an agent, an object it cannot read) keeps
		// the thin card, as before.
		if !placingCards, let link = MarkdownStandaloneLink.match(message.content), linkInfo?(link.url) != nil {
			return true
		}
		return false
	}

	/// The target when the message is nothing but one link drawn as a card.
	private func soleCardTarget(in parts: [LinkedMessagePart]?, appended: [LinkedTarget]) -> LinkedTarget? {
		guard let parts, parts.count == 1, appended.isEmpty, quote == nil, message.attachments.isEmpty,
			case .card(let target) = parts[0]
		else { return nil }
		return target
	}

	/// Pictures and files come first, outside the bubble; a message that is only attachments has no
	/// bubble at all.
	private var attachmentsOnly: Bool {
		!message.attachments.isEmpty && quote == nil && bodyText.isEmpty && !message.isErrorReply
	}

	/// Your attachments are uploading while the message is on its way, and failed with it.
	private var ownTransfer: AttachmentTransfer {
		if message.isFailed { return .failed }
		return message.isPending ? .uploading(progress: nil) : .ready
	}

	private var own: some View {
		// Read once per evaluation: finding the links costs a scan of the text.
		let targets = linkedTargets
		let layout = linkedLayout(for: targets)
		let placingCards = layout != nil
		// Only a link, drawn as a card: the card is the message, right aligned, no bubble.
		let soleCard = soleCardTarget(in: layout?.parts, appended: layout?.appended ?? [])
		return VStack(alignment: .trailing, spacing: MaskinSpace.s2) {
			VStack(alignment: .trailing, spacing: AttachmentLayout.gap) {
				MessageAttachments(
					attachments: message.attachments, alignment: .trailing, threadWidth: rowWidth,
					transfer: ownTransfer, onRetry: onRetrySend)
				if !attachmentsOnly {
					Group {
						if let soleCard {
							LinkedTargetCard(target: soleCard, onApproved: onApprovedDraft)
						} else if hasOwnSurface(placingCards: placingCards) {
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
								if !bodyText.isEmpty {
									if let layout {
										// The card sits nested in the same ink bubble as the words around it.
										linkedBody(layout.parts)
										if message.editedAt != nil { EditedMark() }
									} else {
										HStack(alignment: .lastTextBaseline, spacing: MaskinSpace.s3) {
											MarkdownContent(markdownText, style: .chat, hardBreaks: true)
												.textSelection(.enabled)
											if message.editedAt != nil { EditedMark() }
										}
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
				}
			}
			.frame(maxWidth: .infinity, alignment: .trailing)
			.swipeToReply(onReply)
			.messageContextMenu(message, isOwn: true, actions: actions)
			if let appended = layout?.appended, !appended.isEmpty {
				VStack(alignment: .trailing, spacing: MaskinSpace.s3) {
					ForEach(appended) { LinkedTargetCard(target: $0, onApproved: onApprovedDraft) }
				}
				.frame(maxWidth: rowWidth > 0 ? rowWidth * BubbleShape.myMaxWidthFraction : nil, alignment: .trailing)
			}
			ReactionChips(reactions: message.reactions, isOwn: true, onToggle: onToggleReaction)
			if let threadSummary { ThreadPill(summary: threadSummary, isOwn: true, onOpen: onOpenThread) }
			if mentionChips.isEmpty {
				MentionLine(names: untaggedNames, isOwn: true)
			} else {
				MentionStateLine(chips: mentionChips)
			}
			if let sendStatus {
				MessageStatusLine(status: sendStatus, time: message.createdAt, onRetry: onRetrySend)
			}
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
		.environment(\.markdownStandaloneLink, standaloneStyle(placingCards: placingCards))
		.environment(\.markdownInternalLinkInfo, cappedLinkInfo(targets))
		// Which links are objects worth a card: asked once per target, cached by the store.
		.task(id: targets.map(\.key)) {
			guard let linked, !targets.isEmpty else { return }
			await linked.resolveWithRetries(targets)
		}
	}

	// MARK: Theirs

	private var theirs: some View {
		// Read once per evaluation: finding the links costs a scan of the text.
		let targets = linkedTargets
		let layout = linkedLayout(for: targets)
		return VStack(alignment: .leading, spacing: MaskinSpace.s2) {
			if showsAuthor {
				MessageHeader(
					name: message.actorName, kind: message.author, seed: message.actorID, time: message.createdAt,
					working: working,
					onOpen: message.author == .agent && runtime != nil ? { runtime?.openAgent(message.actorID) } : nil)
			}
			VStack(alignment: .leading, spacing: AttachmentLayout.gap) {
				MessageAttachments(attachments: message.attachments, threadWidth: rowWidth)
				if message.isEmojiOnly {
					Text(message.content).maskinSymbol(emojiSize)
				} else if !attachmentsOnly {
					VStack(alignment: .leading, spacing: MaskinSpace.s3) {
						if let quote { QuoteBlock(author: quote.author, text: quote.text) }
						if !bodyText.isEmpty {
							if let layout {
								linkedBody(layout.parts)
							} else {
								MarkdownContent(markdownText, style: .chat, hardBreaks: message.author == .human)
									.textSelection(.enabled)
							}
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
			if let appended = layout?.appended {
				ForEach(appended) { LinkedTargetCard(target: $0, onApproved: onApprovedDraft) }
			}
			ReactionChips(reactions: message.reactions, onToggle: onToggleReaction)
			if let threadSummary { ThreadPill(summary: threadSummary, onOpen: onOpenThread) }
			if !message.questions.isEmpty {
				QuestionOptionsView(questions: message.questions, answers: questionAnswers, onSubmit: onAnswer)
			}
			if let access = KeychainAccessRequest(message: message) {
				KeychainAccessCard(
					request: access, agentID: message.actorID, conversationID: message.conversationID,
					messageID: message.serverID, answered: cardOutcome, onReply: onKeychainReply)
			}
			if let intro = AgentIntroView(message: message) {
				if introStepsOpen, let steps = intro.steps, let introID = message.serverID, let onSendStep, let onFillStep {
					IntroStepsView(
						steps: steps, onSend: { step, index in onSendStep(step.prompt, introID, index) },
						onFill: onFillStep)
				}
				if let tools = intro.tools { IntroToolsView(providers: tools) }
			}
			if let connect = IntegrationConnectRequest(message: message) {
				IntegrationConnectCard(request: connect)
			}
			if let access = IntegrationAccessRequest(message: message) {
				IntegrationAccessCard(
					request: access, agentID: message.actorID, messageID: message.serverID, answered: cardOutcome,
					onReply: onKeychainReply)
			}
			if let computer = ComputerRequest(message: message) {
				ComputerRequestCard(
					request: computer, agentID: message.actorID, agentName: message.actorName,
					conversationID: message.conversationID, messageID: message.serverID, answered: cardOutcome, onReply: onKeychainReply)
			}
			if let credential = KeychainCredentialRequest(message: message) {
				KeychainRequestCard(
					request: credential, messageCreatedAt: message.createdAt,
					agents: agentsAsking(message), onReply: onKeychainReply)
			}
			if let server = McpServerRequest(message: message) {
				McpServerRequestCard(
					request: server, agentID: message.actorID, messageCreatedAt: message.createdAt,
					messageID: message.serverID,
					answered: cardOutcome, onReply: onKeychainReply)
			}
			footer
			MentionLine(names: untaggedNames, isOwn: false)
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.environment(\.markdownStandaloneLink, standaloneStyle(placingCards: layout != nil))
		.environment(\.markdownInternalLinkInfo, cappedLinkInfo(targets))
		// Which links are objects, drafts or pages worth a card: asked once per target, cached by the store.
		.task(id: targets.map(\.key)) {
			guard let linked, !targets.isEmpty else { return }
			await linked.resolveWithRetries(targets)
		}
	}

	/// The chat's agents, with the one that asked always among them.
	private func agentsAsking(_ message: ChatMessage) -> [ChatParticipant] {
		if chatAgents.contains(where: { $0.id == message.actorID }) { return chatAgents }
		return [ChatParticipant(id: message.actorID, name: message.actorName, kind: .agent)] + chatAgents
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
