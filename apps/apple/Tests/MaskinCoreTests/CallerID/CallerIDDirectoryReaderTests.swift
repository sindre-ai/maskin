import Foundation
import Testing

@testable import MaskinCore

@Suite("CallerIDDirectoryReader")
struct CallerIDDirectoryReaderTests {
	private func tempFile() -> URL {
		FileManager.default.temporaryDirectory.appendingPathComponent("callerid-\(UUID().uuidString)")
			.appendingPathComponent(CallerIDDirectoryReader.relativePath)
	}

	@Test("a file the app's store wrote reads back the same, in the same order")
	func roundTrip() throws {
		let url = tempFile()
		defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent().deletingLastPathComponent()) }
		let store = FileCallerIDListStore(fileURL: url)
		try store.save([
			CallerIDEntry(number: 4_511_111_111, label: "Ada Lovelace"),
			CallerIDEntry(number: 4_522_222_222, label: "Søren Ærø"),
		])

		let read = try CallerIDDirectoryReader.read(from: url)
		#expect(read == [
			.init(number: 4_511_111_111, label: "Ada Lovelace"), .init(number: 4_522_222_222, label: "Søren Ærø"),
		])
	}

	@Test("a layout this build does not know is refused, not half-read")
	func unknownVersion() throws {
		let url = tempFile()
		defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent().deletingLastPathComponent()) }
		try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try Data(#"{"version":2,"entries":[]}"#.utf8).write(to: url)

		#expect(throws: CallerIDDirectoryReader.UnsupportedVersion(version: 2)) {
			try CallerIDDirectoryReader.read(from: url)
		}
	}

	@Test("a file that is not JSON throws, so the phone keeps its earlier list")
	func unreadable() throws {
		let url = tempFile()
		defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent().deletingLastPathComponent()) }
		try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try Data("nope".utf8).write(to: url)

		#expect(throws: (any Error).self) { try CallerIDDirectoryReader.read(from: url) }
	}

	@Test("the phone gets ascending, unique, positive numbers even from an odd file")
	func registrable() {
		let odd: [CallerIDDirectoryReader.Entry] = [
			.init(number: 4_533, label: "C"), .init(number: 0, label: "Zero"), .init(number: 4_511, label: "A"),
			.init(number: -5, label: "Negative"), .init(number: 4_511, label: "A again"),
		]
		#expect(CallerIDDirectoryReader.registrable(odd).map(\.number) == [4_511, 4_533])
		#expect(CallerIDDirectoryReader.registrable([]).isEmpty)
	}

	@Test("the group and the file path agree with the share queue's group")
	func constants() {
		#expect(CallerIDDirectoryReader.appGroupIdentifier == ShareQueue.appGroupIdentifier)
		#expect(CallerIDDirectoryReader.supportedVersion == CallerIDFile.currentVersion)
	}
}
