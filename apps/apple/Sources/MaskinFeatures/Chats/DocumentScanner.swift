#if os(iOS)
import SwiftUI
import UIKit
import VisionKit

/// The system document scanner, for attaching a paper page now. Needs `NSCameraUsageDescription`.
struct DocumentScanner: UIViewControllerRepresentable {
	static var isAvailable: Bool { VNDocumentCameraViewController.isSupported }

	/// Called with the scanned pages, in order, when the person taps Save. Cancelling calls nothing.
	let onScan: ([UIImage]) -> Void
	@Environment(\.dismiss) private var dismiss

	func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
		let scanner = VNDocumentCameraViewController()
		scanner.delegate = context.coordinator
		return scanner
	}

	func updateUIViewController(_ controller: VNDocumentCameraViewController, context: Context) {}

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	final class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
		let parent: DocumentScanner
		init(_ parent: DocumentScanner) { self.parent = parent }

		func documentCameraViewController(
			_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan
		) {
			let pages = (0..<scan.pageCount).map { scan.imageOfPage(at: $0) }
			if !pages.isEmpty { parent.onScan(pages) }
			parent.dismiss()
		}

		func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) { parent.dismiss() }

		func documentCameraViewController(
			_ controller: VNDocumentCameraViewController, didFailWithError error: Error
		) { parent.dismiss() }
	}
}
#endif
