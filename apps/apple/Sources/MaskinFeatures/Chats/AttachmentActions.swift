import MaskinCore
import MaskinDesign
import SwiftUI

#if os(iOS)
	import Photos
	import QuickLook
	import UIKit
#endif

extension EnvironmentValues {
	/// Puts a received file on disk. Supplied by the app root, which owns the file client; absent in
	/// previews and tests, where a tap keeps opening the file screen.
	@Entry var attachmentDownloader: AttachmentDownloader? = nil
}

/// Which files a tap on a file card previews: the message's files (not its pictures, which have
/// their own viewer), in order, starting at the one tapped.
enum AttachmentPreviewPlan {
	static func files(in attachments: [ChatAttachmentRef], opening tapped: ChatAttachmentRef) -> [ChatAttachmentRef] {
		let files = attachments.filter { !$0.isImage }
		return files.contains(tapped) ? files : [tapped]
	}

	static func startIndex(of tapped: ChatAttachmentRef, in files: [ChatAttachmentRef]) -> Int {
		files.firstIndex(of: tapped) ?? 0
	}
}

/// What the person sees after a save: one short line.
enum AttachmentSaveNotice {
	static let savedToFiles = "Saved to Files"
	static let savedToPhotos = "Saved to Photos"
	static let photosDenied = "Allow Maskin to add photos in Settings to save this."
	static let photosFailed = "Couldn't save to Photos"
	static let openFailed = "Couldn't open this file"
}

/// Preview and save for the files of one message or viewer. Hold it as `@State` and attach it with
/// `.attachmentActions(_:)`, which presents Quick Look and the Save to Files sheet.
@MainActor @Observable
final class AttachmentActions {
	struct Preview: Identifiable {
		let id = UUID()
		let urls: [URL]
		let index: Int
	}

	struct Export: Identifiable {
		let id = UUID()
		let url: URL
	}

	var preview: Preview?
	var export: Export?
	/// A file is being fetched.
	private(set) var busy = false
	/// The last outcome, for a toast or pill. The host clears it after showing it.
	var notice: String?

	/// Quick Look and the save sheets need UIKit; elsewhere the caller keeps its old behaviour.
	static var isSupported: Bool {
		#if os(iOS)
			true
		#else
			false
		#endif
	}

	/// Opens `file` in Quick Look, swipeable across the other files of the message.
	func openPreview(
		_ file: ChatAttachmentRef, among attachments: [ChatAttachmentRef], using downloader: AttachmentDownloader
	) {
		guard !busy else { return }
		let files = AttachmentPreviewPlan.files(in: attachments, opening: file)
		let start = AttachmentPreviewPlan.startIndex(of: file, in: files)
		busy = true
		Task {
			// Fetched side by side; a file that fails is left out, unless it is the one tapped.
			let fetched = await withTaskGroup(of: (Int, URL?).self) { group in
				for (index, item) in files.enumerated() {
					group.addTask { (index, try? await downloader.localURL(forFile: item.fileID)) }
				}
				var found: [Int: URL] = [:]
				for await (index, url) in group { if let url { found[index] = url } }
				return found
			}
			busy = false
			guard fetched[start] != nil else {
				notice = AttachmentSaveNotice.openFailed
				return
			}
			let urls = fetched.keys.sorted().compactMap { fetched[$0] }
			let shown = fetched.keys.sorted().firstIndex(of: start) ?? 0
			preview = Preview(urls: urls, index: shown)
		}
	}

	/// Hands the file to the system's "save to Files" sheet.
	func saveToFiles(_ file: ChatAttachmentRef, using downloader: AttachmentDownloader) {
		guard !busy else { return }
		busy = true
		Task {
			defer { busy = false }
			do {
				export = Export(url: try await downloader.localURL(forFile: file.fileID))
			} catch {
				notice = (error as? FileError)?.message ?? AttachmentSaveNotice.openFailed
			}
		}
	}

	/// Adds a picture or video to the photo library. iOS asks for the add-only permission here, the
	/// first time and only if it has not been answered.
	func saveToPhotos(_ file: ChatAttachmentRef, using downloader: AttachmentDownloader) {
		guard !busy, let kind = AttachmentSaveRules.kind(mimeType: file.mimeType, name: file.name) else { return }
		busy = true
		Task {
			defer { busy = false }
			let url: URL
			do { url = try await downloader.localURL(forFile: file.fileID) } catch {
				notice = (error as? FileError)?.message ?? AttachmentSaveNotice.photosFailed
				return
			}
			switch await PhotoSaver.save(url, kind: kind) {
			case .saved: notice = AttachmentSaveNotice.savedToPhotos
			case .denied: notice = AttachmentSaveNotice.photosDenied
			case .failed: notice = AttachmentSaveNotice.photosFailed
			}
		}
	}

	func exportFinished(saved: Bool) {
		export = nil
		if saved { notice = AttachmentSaveNotice.savedToFiles }
	}
}

enum PhotoSaver {
	enum Outcome: Equatable { case saved, denied, failed }

	static func save(_ url: URL, kind: AttachmentSaveRules.MediaKind) async -> Outcome {
		#if os(iOS)
			var status = PHPhotoLibrary.authorizationStatus(for: .addOnly)
			if status == .notDetermined { status = await PHPhotoLibrary.requestAuthorization(for: .addOnly) }
			guard status == .authorized || status == .limited else { return .denied }
			do {
				try await PHPhotoLibrary.shared().performChanges {
					let request = PHAssetCreationRequest.forAsset()
					request.addResource(with: kind == .photo ? .photo : .video, fileURL: url, options: nil)
				}
				return .saved
			} catch {
				return .failed
			}
		#else
			return .failed
		#endif
	}
}

extension View {
	/// Presents Quick Look and the Save to Files sheet for `actions`, with a spinner while a file is
	/// fetched. The outcome shows as the app's toast, or, with `pill`, as a pill on this view (for a
	/// full-screen cover, which sits above the toast).
	func attachmentActions(_ actions: AttachmentActions, pill: Bool = false) -> some View {
		modifier(AttachmentActionsModifier(actions: actions, pill: pill))
	}
}

private struct AttachmentActionsModifier: ViewModifier {
	@Bindable var actions: AttachmentActions
	let pill: Bool
	@Environment(\.showToast) private var showToast

	func body(content: Content) -> some View {
		content
			#if os(iOS)
				.fullScreenCover(item: $actions.preview) { preview in
					QuickLookView(urls: preview.urls, index: preview.index).ignoresSafeArea()
				}
				.sheet(item: $actions.export) { export in
					FileExportPicker(url: export.url) { actions.exportFinished(saved: $0) }
				}
			#endif
			.overlay {
				if actions.busy {
					ProgressView().controlSize(.large)
						.padding(MaskinSpace.s9)
						.maskinGlass(in: RoundedRectangle(cornerRadius: MaskinRadius.card, style: .continuous))
						.accessibilityLabel("Preparing file")
				}
			}
			.overlay(alignment: .bottom) {
				if pill, let notice = actions.notice {
					Text(notice)
						.maskinText(.subhead)
						.foregroundStyle(MaskinColor.ink)
						.padding(.horizontal, MaskinSpace.s9)
						.frame(minHeight: MaskinSpace.touchMin)
						.maskinGlass(in: Capsule())
						.padding(.bottom, MaskinSpace.s14 + MaskinSpace.touchMin)
						.allowsHitTesting(false)
						.accessibilityElement(children: .combine)
						.task(id: notice) {
							AccessibilityNotification.Announcement(notice).post()
							try? await Task.sleep(for: .seconds(2))
							if !Task.isCancelled { actions.notice = nil }
						}
				}
			}
			.onChange(of: actions.notice) { _, notice in
				guard !pill, let notice else { return }
				showToast?(notice)
				AccessibilityNotification.Announcement(notice).post()
				actions.notice = nil
			}
	}
}

#if os(iOS)
	/// Quick Look over the whole screen: swipe between the files, pinch to zoom, share from its toolbar.
	private struct QuickLookView: UIViewControllerRepresentable {
		let urls: [URL]
		let index: Int

		func makeCoordinator() -> Coordinator { Coordinator(urls: urls) }

		func makeUIViewController(context: Context) -> QLPreviewController {
			let controller = QLPreviewController()
			controller.dataSource = context.coordinator
			controller.currentPreviewItemIndex = min(max(index, 0), max(urls.count - 1, 0))
			return controller
		}

		func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

		@MainActor
		final class Coordinator: NSObject, QLPreviewControllerDataSource {
			let urls: [URL]
			init(urls: [URL]) { self.urls = urls }

			func numberOfPreviewItems(in controller: QLPreviewController) -> Int { urls.count }

			func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> any QLPreviewItem {
				urls[index] as NSURL
			}
		}
	}

	/// The system "save to Files" sheet: the person picks a folder and a copy is written there.
	private struct FileExportPicker: UIViewControllerRepresentable {
		let url: URL
		let onFinish: (Bool) -> Void

		func makeCoordinator() -> Coordinator { Coordinator(onFinish: onFinish) }

		func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
			let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
			picker.delegate = context.coordinator
			return picker
		}

		func updateUIViewController(_ picker: UIDocumentPickerViewController, context: Context) {}

		@MainActor
		final class Coordinator: NSObject, UIDocumentPickerDelegate {
			let onFinish: (Bool) -> Void
			init(onFinish: @escaping (Bool) -> Void) { self.onFinish = onFinish }

			func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
				onFinish(true)
			}

			func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onFinish(false) }
		}
	}
#endif
