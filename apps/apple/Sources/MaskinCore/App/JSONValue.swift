import Foundation

/// A decoded JSON value of unknown shape. `WorkspaceEvent.data` carries one so a slice can read
/// the few fields it cares about without the hub having to model every entity.
public enum JSONValue: Sendable, Equatable, Codable {
	case null
	case bool(Bool)
	case number(Double)
	case string(String)
	case array([JSONValue])
	case object([String: JSONValue])

	public init(from decoder: any Decoder) throws {
		let c = try decoder.singleValueContainer()
		if c.decodeNil() {
			self = .null
		} else if let v = try? c.decode(Bool.self) {
			self = .bool(v)
		} else if let v = try? c.decode(Double.self) {
			self = .number(v)
		} else if let v = try? c.decode(String.self) {
			self = .string(v)
		} else if let v = try? c.decode([JSONValue].self) {
			self = .array(v)
		} else {
			self = .object(try c.decode([String: JSONValue].self))
		}
	}

	public func encode(to encoder: any Encoder) throws {
		var c = encoder.singleValueContainer()
		switch self {
		case .null: try c.encodeNil()
		case .bool(let v): try c.encode(v)
		case .number(let v): try c.encode(v)
		case .string(let v): try c.encode(v)
		case .array(let v): try c.encode(v)
		case .object(let v): try c.encode(v)
		}
	}

	public subscript(key: String) -> JSONValue? {
		if case .object(let o) = self { return o[key] }
		return nil
	}

	public var stringValue: String? {
		if case .string(let s) = self { return s }
		return nil
	}
}
