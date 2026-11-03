#if os(iOS)
import SwiftUI
import UIKit

/// The system camera, for attaching a photo taken now. Needs `NSCameraUsageDescription`.
struct CameraPicker: UIViewControllerRepresentable {
	static var isAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

	/// Called with the photo as JPEG data when one is taken.
	let onPhoto: (Data) -> Void
	@Environment(\.dismiss) private var dismiss

	func makeUIViewController(context: Context) -> UIImagePickerController {
		let picker = UIImagePickerController()
		picker.sourceType = .camera
		picker.delegate = context.coordinator
		return picker
	}

	func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
		let parent: CameraPicker
		init(_ parent: CameraPicker) { self.parent = parent }

		func imagePickerController(
			_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
		) {
			if let image = info[.originalImage] as? UIImage, let data = image.jpegData(compressionQuality: 0.9) {
				parent.onPhoto(data)
			}
			parent.dismiss()
		}

		func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { parent.dismiss() }
	}
}
#endif
