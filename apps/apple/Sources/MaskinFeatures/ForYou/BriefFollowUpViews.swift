import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The two suggestions above the follow-up composer.
struct BriefFollowUpChips: View {
	let ask: (String) -> Void

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			HStack(spacing: MaskinSpace.s4) {
				ForEach(BriefFollowUp.chips, id: \.self) { chip in
					Button { ask(chip) } label: {
						Text(chip)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
							.foregroundStyle(BriefViewerPalette.ink)
							.padding(.horizontal, MaskinSpace.s9)
							.frame(minHeight: MaskinSpace.touchMin)
							.background(BriefViewerPalette.fill, in: Capsule())
							.contentShape(Capsule())
					}
					.buttonStyle(.maskinPressed(.shrink))
				}
			}
		}
		.scrollClipDisabled()
	}
}

/// "Ask Chief of Staff about this slide": a field, the mic and Send, pinned to the bottom of the viewer.
struct BriefFollowUpComposer: View {
	@Bindable var model: BriefFollowUpModel
	var focused: FocusState<Bool>.Binding
	let send: () -> Void
	@State private var listening = false

	private var canSend: Bool {
		!model.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !model.isOpening
	}

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			TextField(
				"", text: $model.text,
				prompt: Text(BriefFollowUp.placeholder).foregroundStyle(BriefViewerPalette.placeholder)
			)
			.focused(focused)
			.submitLabel(.send)
			.onSubmit { if canSend { send() } }
			.font(MaskinTypeface.sans(MaskinFontSize.t17))
			.foregroundStyle(BriefViewerPalette.ink)
			.tint(BriefViewerPalette.ink)
			.padding(.leading, MaskinSpace.s9)
			.frame(minHeight: MaskinSpace.touchMin + MaskinSpace.s5)
			.accessibilityLabel(BriefFollowUp.placeholder)
			DictationButton(text: $model.text, listening: $listening)
			Button(action: send) {
				Image(systemName: "arrow.up")
					.font(MaskinTypeface.sans(MaskinFontSize.t17, weight: .semibold))
					.foregroundStyle(BriefViewerPalette.ink)
					.frame(width: MaskinSpace.touchMin, height: MaskinSpace.touchMin)
					.background(canSend ? BriefViewerPalette.fillStrong : BriefViewerPalette.fillDisabled, in: Circle())
			}
			.buttonStyle(.maskinPressed(.shrink))
			.disabled(!canSend)
			.accessibilityLabel("Send")
		}
		.padding(.trailing, MaskinSpace.s2)
		.background(BriefViewerPalette.fillSoft, in: Capsule())
		.overlay(Capsule().strokeBorder(BriefViewerPalette.stroke, lineWidth: 1))
	}
}

/// The exchange above the composer: the reader's question, the agent's answer as it arrives, and
/// "Continue in chat". The slide text and buttons fold away while it is open.
struct BriefFollowUpPanel: View {
	let model: BriefFollowUpModel
	let continueInChat: (String) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			ScrollView {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					ForEach(model.exchange) { message in bubble(message) }
					if model.isAwaitingReply {
						ProgressView().tint(BriefViewerPalette.ink).padding(.leading, MaskinSpace.s5)
							.accessibilityLabel("Waiting for a reply")
					}
				}
				.frame(maxWidth: .infinity, alignment: .leading)
			}
			.defaultScrollAnchor(.bottom)
			if let conversationID = model.conversationID {
				Button { continueInChat(conversationID) } label: {
					Text("Continue in chat")
						.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
						.foregroundStyle(BriefViewerPalette.ink)
						.underline()
						.frame(minHeight: MaskinSpace.touchMin, alignment: .leading)
				}
				.buttonStyle(.maskinPressed(.shrink))
			}
			if let notice = model.notice {
				Text(notice).maskinText(.caption).foregroundStyle(MaskinColor.patina100)
			}
		}
		.padding(MaskinSpace.s7)
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(BriefViewerPalette.panel, in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
		.accessibilityElement(children: .contain)
		.accessibilityLabel("Follow-up with \(BriefFollowUp.author)")
	}

	@ViewBuilder
	private func bubble(_ message: ChatMessage) -> some View {
		let mine = message.author != .agent
		HStack(spacing: 0) {
			if mine { Spacer(minLength: MaskinSpace.s14) }
			Text(BriefFollowUp.displayText(message.content))
				.font(MaskinTypeface.sans(MaskinFontSize.t16))
				.foregroundStyle(mine ? BriefViewerPalette.bubbleMineText : BriefViewerPalette.ink)
				.padding(.horizontal, MaskinSpace.s7)
				.padding(.vertical, MaskinSpace.s5)
				.background(
					mine ? BriefViewerPalette.bubbleMine : BriefViewerPalette.fill,
					in: RoundedRectangle(cornerRadius: MaskinRadius.cardXl, style: .continuous))
			if !mine { Spacer(minLength: MaskinSpace.s14) }
		}
	}
}
