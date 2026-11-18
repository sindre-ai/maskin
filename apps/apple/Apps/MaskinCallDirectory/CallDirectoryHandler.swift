import CallKit
import Foundation

/// Gives the phone the names of the people Maskin holds, so an incoming call from a known number
/// shows their name. Names only, incoming calls only.
///
/// It reads one file the app wrote into the shared App Group folder (`CallerIDDirectoryReader`) and
/// registers its numbers and names. It uses no network and does nothing else. The phone's own
/// Contacts win over this list, which is expected. Extension memory is tight, so it compiles only
/// the reader and links nothing else.
final class CallDirectoryHandler: CXCallDirectoryProvider {
	override func beginRequest(with context: CXCallDirectoryExtensionContext) {
		// A reload replaces the whole list: clear what the phone holds, then add everything again.
		if context.isIncremental { context.removeAllIdentificationEntries() }

		// No file means signed out, or never refreshed: the list is now empty, which is right.
		guard let url = CallerIDDirectoryReader.fileURL(), FileManager.default.fileExists(atPath: url.path) else {
			context.completeRequest()
			return
		}
		do {
			for entry in CallerIDDirectoryReader.registrable(try CallerIDDirectoryReader.read(from: url)) {
				context.addIdentificationEntry(withNextSequentialPhoneNumber: entry.number, label: entry.label)
			}
			context.completeRequest()
		} catch {
			// An unreadable file keeps the phone's earlier list; the next app open writes a new one.
			context.cancelRequest(withError: error)
		}
	}
}
