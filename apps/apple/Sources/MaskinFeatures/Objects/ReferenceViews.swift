import MaskinCore
import MaskinDesign
import MaskinUI
import SwiftUI

/// The `/` picker above the comment composer: objects matching what was typed after the slash.
struct ReferenceSuggestions: View {
	let results: [CommentReference]
	let isSearching: Bool
	let onPick: (CommentReference) -> Void

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			if results.isEmpty {
				Text(isSearching ? "Searching…" : "No object by that name")
					.maskinText(.subhead).foregroundStyle(MaskinColor.ink4)
					.padding(MaskinSpace.s8)
			} else {
				ForEach(results.prefix(6)) { ref in
					Button {
						MaskinHaptics.play(.selection)
						onPick(ref)
					} label: {
						HStack(spacing: MaskinSpace.s6) {
							TypeBadge(ref.type)
							Text(ref.title).maskinText(.body).foregroundStyle(MaskinColor.ink).lineLimit(1)
							Spacer(minLength: 0)
						}
						.padding(.horizontal, MaskinSpace.s8)
						.frame(minHeight: MaskinSpace.touchMin)
						.contentShape(Rectangle())
					}
					.buttonStyle(.plain)
					.accessibilityLabel("Link \(ref.title)")
				}
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
	}
}

/// A linked object: in the composer it has a remove button, under a posted comment it opens the
/// object (when the screen can navigate).
struct ReferenceChip: View {
	let ref: CommentReference
	var onOpen: (() -> Void)?
	var onRemove: (() -> Void)?

	var body: some View {
		HStack(spacing: MaskinSpace.s4) {
			if let onOpen {
				Button(action: onOpen) { label }.buttonStyle(.plain)
			} else {
				label
			}
			if let onRemove {
				Button(action: onRemove) {
					Image(systemName: "xmark.circle.fill").foregroundStyle(MaskinColor.ink5)
						.frame(width: MaskinSpace.touchMin - MaskinSpace.s4, height: MaskinSpace.touchMin - MaskinSpace.s4)
						.contentShape(Rectangle())
				}
				.buttonStyle(.plain)
				.accessibilityLabel("Remove \(ref.title)")
			}
		}
		.padding(.leading, MaskinSpace.s5)
		.padding(.trailing, onRemove == nil ? MaskinSpace.s5 : 0)
		.padding(.vertical, MaskinSpace.s1)
		.background(MaskinSurface.fill, in: Capsule())
	}

	private var label: some View {
		HStack(spacing: MaskinSpace.s3) {
			TypeBadge(ref.type, style: .dot)
			Text(ref.title).maskinText(.caption).foregroundStyle(MaskinColor.ink)
				.lineLimit(1).truncationMode(.tail)
		}
		.contentShape(Rectangle())
	}
}

/// A file attached to a posted comment: icon, name and size.
struct AttachedFileChip: View {
	let file: FileSummary

	var body: some View {
		HStack(spacing: MaskinSpace.s3) {
			Image(systemName: file.mimeType.hasPrefix("image/") ? "photo" : "doc")
				.foregroundStyle(MaskinColor.ink3).accessibilityHidden(true)
			VStack(alignment: .leading, spacing: 0) {
				Text(file.name).maskinText(.caption).foregroundStyle(MaskinColor.ink)
					.lineLimit(1).truncationMode(.middle)
				if let size = ChatByteFormat.string(file.sizeBytes > 0 ? file.sizeBytes : nil) {
					Text(size).maskinText(.microLabel).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.padding(.horizontal, MaskinSpace.s5)
		.padding(.vertical, MaskinSpace.s2)
		.frame(maxWidth: 260, alignment: .leading)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: MaskinRadius.btnLg, style: .continuous)
				.strokeBorder(MaskinSurface.line, lineWidth: 1))
		.accessibilityElement(children: .combine)
	}
}
