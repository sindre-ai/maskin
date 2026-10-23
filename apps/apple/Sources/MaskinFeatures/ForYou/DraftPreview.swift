import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The agent's outbound draft inside a decision card, laid out as in v6: a label, a "To" row,
/// then the whole body, never cut. When the server sent a `preview` the
/// To / Cc / Subject / detail lines and any missing or warning notes come from it, with a receipt
/// chip once the draft is approved or sent. A card about a file shows the file instead of text.
/// Read only on the phone: Approve replies with the send option and the server approves the exact
/// text it holds, so a change is made through Discuss or on the web.
struct DraftPreview: View {
	let draft: DecisionDraft
	/// Says that Approve sends the draft as written. Off where the card has no Approve (the
	/// object's own screen shows the draft for reading only).
	var showsReadOnlyNote = true

	private var recipient: String? {
		draft.to?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
	}

	private var receipt: String? {
		switch draft.preview?.delivery {
		case .approved: "Approved"
		case .sent: "Sent"
		default: nil
		}
	}

	var body: some View {
		if let file = draft.file {
			DraftFileCard(file: file)
		} else {
			textDraft
		}
	}

	private var textDraft: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s4) {
			HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s4) {
				Text(draft.preview?.label ?? draft.label)
					.font(MaskinTypeface.sans(MaskinFontSize.t13, weight: MaskinFontWeight.w650))
					.foregroundStyle(MaskinColor.ink4)
				Spacer(minLength: 0)
				if let receipt { ReceiptChip(text: receipt) }
			}
			if let preview = draft.preview {
				ObjectPreviewMetaView(preview: preview)
			} else if let recipient {
				VStack(alignment: .leading, spacing: MaskinSpace.s4) {
					HStack(alignment: .firstTextBaseline, spacing: MaskinSpace.s5) {
						Text("To")
							.font(MaskinTypeface.sans(MaskinFontSize.t14))
							.foregroundStyle(MaskinColor.ink5)
							.frame(width: 56, alignment: .leading)
						Text(recipient)
							.font(MaskinTypeface.sans(MaskinFontSize.t14, weight: MaskinFontWeight.w650))
							.foregroundStyle(MaskinColor.ink)
							.frame(maxWidth: .infinity, alignment: .leading)
					}
					Rectangle().fill(MaskinSurface.separator).frame(height: 1)
				}
			}
			Text(draft.body)
				.font(MaskinTypeface.sans(MaskinFontSize.t15))
				.lineSpacing(MaskinSpace.s2)
				.foregroundStyle(MaskinColor.ink)
				.frame(maxWidth: .infinity, alignment: .leading)
			if showsReadOnlyNote, receipt == nil {
				Text("Approve sends this draft as written. To change it, use Discuss or edit it on the web.")
					.font(MaskinTypeface.sans(MaskinFontSize.t12))
					.foregroundStyle(MaskinColor.ink5)
					.frame(maxWidth: .infinity, alignment: .leading)
			}
		}
		.padding(MaskinSpace.s8)
		.frame(maxWidth: .infinity, alignment: .leading)
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .contain)
	}
}

/// "Approved" / "Sent": what already happened to a draft, as a quiet chip.
struct ReceiptChip: View {
	let text: String

	var body: some View {
		HStack(spacing: MaskinSpace.s2) {
			Image(systemName: "checkmark").font(MaskinTypeface.sans(MaskinFontSize.t11, weight: .bold))
				.accessibilityHidden(true)
			Text(text).font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold))
		}
		.foregroundStyle(MaskinColor.successStrong)
		.padding(.horizontal, MaskinSpace.s4)
		.padding(.vertical, MaskinSpace.s2)
		.background(MaskinColor.successTint, in: Capsule())
		.accessibilityElement(children: .combine)
	}
}

/// A card about a file: its type and name, the picture itself for an image, and a tap to open the
/// full viewer. Never an empty box: a file that can't be loaded is just the header.
struct DraftFileCard: View {
	let file: FileReference
	@Environment(\.attachmentImages) private var images
	@Environment(\.openAttachment) private var open
	@Environment(\.displayScale) private var displayScale
	@State private var loaded: DecodedImage?

	private static let imageMaxHeight = MaskinSpace.touchMin * 6

	private var size: String? { ChatByteFormat.string(file.sizeBytes > 0 ? file.sizeBytes : nil) }

	var body: some View {
		let shape = RoundedRectangle(cornerRadius: MaskinRadius.panelXl, style: .continuous)
		Button { open?(file.id) } label: {
			VStack(alignment: .leading, spacing: MaskinSpace.s5) {
				HStack(spacing: MaskinSpace.s4) {
					Text(file.kindLabel)
						.font(MaskinTypeface.sans(MaskinFontSize.t12, weight: .semibold))
						.foregroundStyle(MaskinColor.ink3)
						.padding(.horizontal, MaskinSpace.s4)
						.padding(.vertical, MaskinSpace.s2)
						.background(MaskinSurface.card, in: Capsule())
						.overlay(Capsule().strokeBorder(MaskinSurface.line, lineWidth: 1))
					Spacer(minLength: 0)
					if open != nil {
						Image(systemName: "arrow.up.forward").foregroundStyle(MaskinColor.ink4)
							.font(MaskinTypeface.sans(MaskinFontSize.t13)).accessibilityHidden(true)
					}
				}
				Text(file.name)
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: MaskinFontWeight.w650))
					.foregroundStyle(MaskinColor.ink)
					.frame(maxWidth: .infinity, alignment: .leading)
				if let size {
					Text(size).font(MaskinTypeface.sans(MaskinFontSize.t12)).foregroundStyle(MaskinColor.ink5)
				}
				if file.isImage, let image = loaded ?? images?.cached(file.id) {
					Image(decorative: image.cgImage, scale: displayScale).resizable().scaledToFit()
						.frame(maxWidth: .infinity, maxHeight: Self.imageMaxHeight)
						.clipShape(RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
				}
			}
			.padding(MaskinSpace.s8)
			.frame(maxWidth: .infinity, alignment: .leading)
			.overlay(shape.strokeBorder(MaskinSurface.line, lineWidth: 1))
			.contentShape(shape)
		}
		.buttonStyle(.maskinPressed(.shrink))
		.disabled(open == nil)
		.accessibilityLabel("\(file.kindLabel) \(file.name)")
		.accessibilityHint(open == nil ? "" : "Opens the file")
		.task(id: file.id) {
			guard file.isImage, loaded == nil, let images, images.cached(file.id) == nil else { return }
			loaded = await images.load(file.id)
		}
	}
}

private extension String {
	var nonEmpty: String? { isEmpty ? nil : self }
}

/// "This can't be undone": the sheet an option that reaches real people or money asks through,
/// shown for options the agent marked `destructive`. Confirm is ink; Cancel is quiet.
struct ConfirmOptionSheet: View {
	let option: DecisionOption
	let confirm: () -> Void
	@Environment(\.dismiss) private var dismiss

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s9) {
			Text("\(option.label)?").maskinText(.sheetTitle).foregroundStyle(MaskinColor.ink)
			VStack(alignment: .leading, spacing: MaskinSpace.s4) {
				Text("This can\u{2019}t be undone.")
					.maskinText(.body).fontWeight(.semibold).foregroundStyle(MaskinColor.ink)
				ForEach(option.consequences, id: \.self) {
					Text($0).maskinText(.body).foregroundStyle(MaskinColor.ink3)
				}
			}
			.frame(maxWidth: .infinity, alignment: .leading)
			Spacer(minLength: 0)
			Button {
				dismiss()
				confirm()
			} label: {
				Text("Confirm")
					.font(MaskinTypeface.sans(MaskinFontSize.t15, weight: .bold))
					.foregroundStyle(MaskinSurface.onInverse)
					.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin + MaskinSpace.s4)
					.background(MaskinSurface.inverse, in: Capsule())
			}
			.buttonStyle(.maskinPressed(.shrink))
			Button("Cancel") { dismiss() }
				.maskinText(.body).foregroundStyle(MaskinColor.ink4)
				.frame(maxWidth: .infinity, minHeight: MaskinSpace.touchMin)
		}
		.padding(MaskinSpace.s11)
		.presentationDetents([.medium])
		.presentationDragIndicator(.visible)
		.ambientBackground(showsBottom: false)
	}
}
