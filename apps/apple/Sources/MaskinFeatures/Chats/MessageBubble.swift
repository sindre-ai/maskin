import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// Spec 7 §3 bubbles. Theirs (agents and people): `card` fill, `fg2` text, tail top-left, padding
/// 13×15, the full column; a 24pt avatar + name + time header 6pt above the first of a run. Mine:
/// `inv` fill, `invFg` text, tail bottom-right, padding 11×15, at most 82% wide, no header.
/// Type the spec sets inside chat content that the shared roles do not cover: mono 11pt labels
/// (dividers, PINNED), where `.microLabel` is 10pt.
enum ChatType {
	static let mono11 = MaskinTypeface.mono(MaskinFontSize.t11, weight: .semibold, relativeTo: .caption2)
	static let mono11Tracking: CGFloat = MaskinFontSize.t11 * 0.08
}

enum BubbleShape {
	static let big: CGFloat = MaskinRadius.tile
	static let tail: CGFloat = MaskinRadius.input

	static var agent: UnevenRoundedRectangle {
		UnevenRoundedRectangle(
			topLeadingRadius: tail, bottomLeadingRadius: big, bottomTrailingRadius: big, topTrailingRadius: big,
			style: .continuous)
	}

	static var mine: UnevenRoundedRectangle {
		UnevenRoundedRectangle(
			topLeadingRadius: big, bottomLeadingRadius: big, bottomTrailingRadius: tail, topTrailingRadius: big,
			style: .continuous)
	}

	/// 13 × 15 for theirs, 11 × 15 for mine (list gap 16 minus 11 is the grouped gap).
	static let theirVertical: CGFloat = MaskinSpace.s7 + MaskinSpace.s1
	static let myVertical: CGFloat = MaskinSpace.s6
	static let horizontal: CGFloat = MaskinSpace.s8 + MaskinSpace.s1
	static let myMaxWidthFraction: CGFloat = 0.82
	/// 16pt type at 1.47 line height.
	static let lineSpacing: CGFloat = MaskinSpace.s2
}

/// 24pt avatar, 14pt semibold name, 12pt `fg5` time: shown 6pt above the first bubble of a run.
struct MessageHeader: View {
	let name: String
	let kind: ChatParticipant.Kind
	let seed: String
	let time: Date?
	var working = false
	/// Opens the sender's page (an agent's); nil for a person, who has no page yet.
	var onOpen: (() -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			let identity = HStack(spacing: MaskinSpace.s4) {
				ActorAvatar(name: name, kind: kind == .agent ? .agent : .human, size: MaskinSpace.s12, seed: seed, working: working)
					.accessibilityHidden(true)
				Text(name).font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .semibold, relativeTo: .subheadline))
					.foregroundStyle(MaskinColor.ink).lineLimit(1)
			}
			if let onOpen {
				Button(action: onOpen) { identity.contentShape(Rectangle()) }
					.buttonStyle(.maskinPressed)
					.accessibilityLabel("\(name), open agent")
			} else {
				identity
			}
			if let time {
				RelativeTime(time, style: .clock)
					.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink5)
			}
			Spacer(minLength: 0)
		}
		.padding(.bottom, MaskinSpace.s3 - MaskinSpace.s1)
	}
}

/// The quote at the top of a reply: a 3pt `sigHi` rule, the name in bold 14pt, the quoted text in full.
struct QuoteBlock: View {
	let author: String
	let text: String
	var onInverse = false

	var body: some View {
		HStack(alignment: .top, spacing: MaskinSpace.s4) {
			RoundedRectangle(cornerRadius: MaskinRadius.tag, style: .continuous)
				.fill(MaskinColor.sigHi).frame(width: MaskinSpace.s1 + 1)
			VStack(alignment: .leading, spacing: MaskinSpace.s1) {
				Text(author).font(MaskinTypeface.sans(MaskinFontSize.t14, weight: .bold, relativeTo: .subheadline))
					.foregroundStyle(onInverse ? MaskinSurface.onInverse : MaskinColor.ink3)
				Text(text).font(MaskinTypeface.sans(MaskinFontSize.t14, relativeTo: .subheadline))
					.foregroundStyle(onInverse ? MaskinSurface.onInverse.opacity(0.78) : MaskinColor.ink4)
			}
		}
		.fixedSize(horizontal: false, vertical: true)
		.padding(.bottom, MaskinSpace.s3)
		.accessibilityElement(children: .combine)
		.accessibilityLabel("Replying to \(author): \(text)")
	}
}

/// The inline `edited` mark: 12pt at 60% opacity, inside the bubble.
struct EditedMark: View {
	var body: some View {
		Text("edited").font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).opacity(0.6)
	}
}

/// Your own words: inline markdown (bold, links) in the inverse text colour, line breaks kept.
struct OwnMessageText: View {
	let markdown: String

	var body: some View {
		Text(Self.attributed(markdown))
			.font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
			.lineSpacing(BubbleShape.lineSpacing)
			.tint(MaskinSurface.onInverse)
			.textSelection(.enabled)
	}

	static func attributed(_ markdown: String) -> AttributedString {
		(try? AttributedString(
			markdown: markdown, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
			?? AttributedString(markdown)
	}
}

/// Where your newest message stands, right-aligned under it: `{time} · Read by {agent}`, `Sent`,
/// `Sending…`, or `Not sent · Tap to retry` in the send-failed red.
enum MessageSendStatus: Equatable {
	case sending
	case sent
	case read(by: String)
	case notSent

	/// From a message plus who has read it (`ChatStore.readBy`).
	static func of(_ message: ChatMessage, readBy: String?) -> MessageSendStatus {
		switch message.status {
		case .sending: return .sending
		case .waiting, .failed: return .notSent
		case .sent:
			if let readBy { return .read(by: readBy) }
			return .sent
		}
	}
}

struct MessageStatusLine: View {
	let status: MessageSendStatus
	var time: Date?
	var onRetry: () -> Void = {}

	var body: some View {
		Group {
			switch status {
			case .sending:
				label("Sending…")
			case .sent:
				label("Sent")
			case .read(let by):
				HStack(spacing: MaskinSpace.s1) {
					if let time { RelativeTime(time, style: .clock) }
					Text("· Read by \(by)")
				}
				.font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink5)
			case .notSent:
				Button(action: onRetry) {
					Text("Not sent · Tap to retry")
						.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold, relativeTo: .caption))
						.foregroundStyle(MaskinColor.danger)
						.frame(minHeight: MaskinSpace.touchMin - MaskinSpace.s7)
						.contentShape(Rectangle())
				}
				.buttonStyle(.maskinPressed)
				.accessibilityLabel("Not sent. Tap to retry.")
			}
		}
		.frame(maxWidth: .infinity, alignment: .trailing)
		.padding(.top, MaskinSpace.s1)
	}

	private func label(_ text: String) -> some View {
		Text(text).font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink5)
	}
}

/// `‹ 2/2 ›` under an agent bubble once it has more than one answer. Mono 12pt `fg4`, 32pt arrow hit
/// areas, disabled arrows at 30%; locked while a reply is streaming.
struct VersionPager: View {
	let index: Int
	let count: Int
	var locked = false
	let onStep: (Int) -> Void

	var body: some View {
		HStack(spacing: MaskinSpace.s1) {
			arrow("chevron.left", enabled: index > 0 && !locked, label: "Previous answer") { onStep(index - 1) }
			Text("\(index + 1)/\(count)")
				.font(MaskinTypeface.mono(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink4)
				.monospacedDigit()
			arrow("chevron.right", enabled: index < count - 1 && !locked, label: "Next answer") { onStep(index + 1) }
		}
		.accessibilityElement(children: .contain)
	}

	private func arrow(_ symbol: String, enabled: Bool, label: String, action: @escaping () -> Void) -> some View {
		Button(action: action) {
			Image(systemName: symbol).font(.system(size: MaskinFontSize.t12, weight: .semibold))
				.foregroundStyle(MaskinColor.ink4)
				.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
				.contentShape(Rectangle())
		}
		.buttonStyle(.maskinPressed)
		.disabled(!enabled)
		.opacity(enabled ? 1 : 0.3)
		.accessibilityLabel(label)
	}
}

/// `Stopped`, 12pt `fg5`, under a reply the user cut short.
struct StoppedLabel: View {
	var body: some View {
		Text("Stopped").font(MaskinTypeface.sans(MaskinFontSize.t12, relativeTo: .caption)).foregroundStyle(MaskinColor.ink5)
	}
}

/// A reply still on its way: the agent header, then the partial text with a blinking caret in an
/// agent bubble, or — when nothing has streamed yet — the typing dots. Keeps at least the typing
/// bubble's height so the row doesn't jump when text arrives.
struct StreamingReplyBubble: View {
	let agent: ChatParticipant
	var text: String?
	var stopped = false

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s3) {
			MessageHeader(name: agent.name, kind: agent.kind, seed: agent.id, time: nil, working: !stopped)
			Group {
				if let text, !text.isEmpty {
					HStack(alignment: .lastTextBaseline, spacing: MaskinSpace.s1) {
						Text(text).font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body))
							.lineSpacing(BubbleShape.lineSpacing).foregroundStyle(MaskinColor.ink2)
						if !stopped { BlinkingCaret() }
					}
				} else if stopped {
					Text("—").font(MaskinTypeface.sans(MaskinFontSize.t16, relativeTo: .body)).foregroundStyle(MaskinColor.ink5)
						.accessibilityHidden(true)
				} else {
					TypingDots()
				}
			}
			.padding(.vertical, BubbleShape.theirVertical)
			.padding(.horizontal, BubbleShape.horizontal)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s2, alignment: .leading)
			.background(MaskinSurface.card, in: BubbleShape.agent)
			if stopped { StoppedLabel() }
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.accessibilityElement(children: .combine)
		.accessibilityLabel(stopped ? "\(agent.name)'s reply was stopped" : "\(agent.name) is replying")
	}
}
