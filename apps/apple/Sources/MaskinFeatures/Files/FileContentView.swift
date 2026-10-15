import MaskinCore
import MaskinDesign
import MaskinUI
import PDFKit
import SwiftUI

/// A loaded file's body, routed by content kind: markdown reads like a document, text and source
/// are monospaced, images and PDFs use the system viewers, anything else shows its metadata.
struct FileContentView: View {
	let file: FileDetail
	var showsSource = false
	/// Decoded once by `FileStore`; falls back to decoding here for callers without a store.
	var text: String?
	/// Changes whenever the bytes change, so images and PDFs refresh without re-decoding per render.
	var revision = 0

	private var fileText: String { text ?? file.text ?? "" }

	var body: some View {
		switch file.kind {
		case .markdown:
			if showsSource { FileSourceText(text: fileText, revision: revision) } else {
				WindowedText(text: fileText, revision: revision) { MarkdownContent($0).textSelection(.enabled) }
			}
		case .text, .source, .html:
			FileSourceText(text: fileText, revision: revision)
		case .image:
			FileImageView(data: file.data, name: file.name, revision: revision)
		case .pdf:
			FilePDFView(data: file.data, revision: revision)
				.frame(minHeight: 480)
		case .other:
			EmptyState(
				symbol: "doc", title: "No preview for this file",
				message: "\(FileContentKind.label(forMime: file.mimeType)) · \(file.mimeType). Use Share to open it in another app.")
		}
	}
}

/// Lays out only a prefix of long text, with "Show more" up to a ceiling; beyond it Share is the
/// way to read the rest. Keeps a 10 MB file from hanging the main thread in one `Text`.
private struct WindowedText<Content: View>: View {
	let text: String
	let revision: Int
	@ViewBuilder let content: (String) -> Content
	@State private var limit = FileTextWindow.step

	var body: some View {
		let window = FileTextWindow.prefix(text, limit: limit)
		VStack(alignment: .leading, spacing: MaskinSpace.s7) {
			content(String(window.shown))
			if window.isTruncated {
				if limit < FileTextWindow.ceiling {
					Button("Show more") { limit = min(limit + FileTextWindow.step, FileTextWindow.ceiling) }
						.buttonStyle(SecondaryActionButtonStyle())
				} else {
					Text("This file is too long to show in full. Use Share to open it in another app.")
						.maskinText(.caption).foregroundStyle(MaskinColor.ink4)
				}
			}
		}
		.onChange(of: revision) { _, _ in limit = FileTextWindow.step }
	}
}

struct FileSourceText: View {
	let text: String
	var revision = 0

	var body: some View {
		WindowedText(text: text, revision: revision) { shown in
			Text(shown)
				.maskinText(.mono)
				.foregroundStyle(MaskinColor.ink)
				.textSelection(.enabled)
				.frame(maxWidth: .infinity, alignment: .leading)
				.padding(MaskinSpace.s7)
				.background(MaskinSurface.cardInset2, in: RoundedRectangle(cornerRadius: MaskinRadius.input))
		}
	}
}

/// Decodes a bounded thumbnail off the main thread, once per revision.
private struct FileImageView: View {
	let data: Data
	let name: String
	let revision: Int
	@State private var image: DecodedImage?
	@State private var failed = false

	var body: some View {
		Group {
			if let image {
				Image(decorative: image.cgImage, scale: 1)
					.resizable().scaledToFit().accessibilityLabel(name)
			} else if failed {
				EmptyState(symbol: "photo", title: "Couldn't show this image")
			} else {
				LoadingSkeleton(rows: 3)
			}
		}
		.task(id: revision) {
			let bytes = data
			let decoded = await Task.detached(priority: .userInitiated) { FileImageDecoder.thumbnail(bytes) }.value
			image = decoded
			failed = decoded == nil
		}
	}
}

#if canImport(UIKit)
private struct FilePDFView: UIViewRepresentable {
	let data: Data
	let revision: Int
	func makeCoordinator() -> Coordinator { Coordinator() }
	func makeUIView(context: Context) -> PDFView {
		let view = PDFView()
		view.autoScales = true
		return view
	}
	func updateUIView(_ view: PDFView, context: Context) {
		guard context.coordinator.revision != revision || view.document == nil else { return }
		context.coordinator.revision = revision
		view.document = PDFDocument(data: data)
	}
	final class Coordinator { var revision = -1 }
}
#else
private struct FilePDFView: NSViewRepresentable {
	let data: Data
	let revision: Int
	func makeCoordinator() -> Coordinator { Coordinator() }
	func makeNSView(context: Context) -> PDFView {
		let view = PDFView()
		view.autoScales = true
		return view
	}
	func updateNSView(_ view: PDFView, context: Context) {
		guard context.coordinator.revision != revision || view.document == nil else { return }
		context.coordinator.revision = revision
		view.document = PDFDocument(data: data)
	}
	final class Coordinator { var revision = -1 }
}
#endif

/// Review comments pinned to a file, as a list. Tapping one opens it for editing.
struct FileReviewComments: View {
	let annotations: [FileAnnotation]
	var onSelect: ((FileAnnotation) -> Void)?

	var body: some View {
		VStack(alignment: .leading, spacing: MaskinSpace.s5) {
			SectionHeader("Review comments") {
				ShareLink(item: FileAnnotationRules.exportJSON(annotations)) {
					Label("Export", systemImage: "square.and.arrow.up").labelStyle(.iconOnly)
				}
				.foregroundStyle(MaskinColor.ink4)
				.accessibilityLabel("Export comments as JSON")
			}
			ForEach(annotations) { annotation in
				Button { onSelect?(annotation) } label: { row(annotation) }
					.buttonStyle(.maskinPressed)
					.disabled(onSelect == nil)
			}
		}
		.padding(MaskinSpace.s7)
		.background(MaskinSurface.card, in: RoundedRectangle(cornerRadius: MaskinRadius.hero, style: .continuous))
	}

	private func row(_ annotation: FileAnnotation) -> some View {
		HStack(alignment: .top, spacing: MaskinSpace.s5) {
			Text(annotation.pinNumber.map(String.init) ?? "•")
				.maskinText(.caption)
				.foregroundStyle(MaskinColor.ink)
				.frame(minWidth: MaskinSpace.s9, minHeight: MaskinSpace.s9)
				.background(MaskinSurface.fillStrong, in: Circle())
				.accessibilityLabel(annotation.pinNumber.map { "Pin \($0)" } ?? "Comment")
			Text(annotation.comment)
				.maskinText(.body)
				.foregroundStyle(MaskinColor.ink)
				.multilineTextAlignment(.leading)
				.frame(maxWidth: .infinity, alignment: .leading)
		}
		.frame(minHeight: MaskinSpace.touchMin)
		.contentShape(Rectangle())
	}
}
