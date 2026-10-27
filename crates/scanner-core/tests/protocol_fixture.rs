//! Cross-language contract check.
//!
//! `fixtures/analysis/scanner-hello.ndjson` is a real captured handshake record,
//! not hand-written. The TypeScript client parses the same file in
//! `packages/contracts/test/contracts.test.ts`. If either side changes the
//! protocol shape without the other, one of the two suites fails.

use std::fs;
use std::path::PathBuf;

use scanner_core::protocol::ProtocolVersion;
use scanner_core::rules::RULES;
use serde_json::Value;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../fixtures/analysis/scanner-hello.ndjson");
    let raw = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    let line = raw.lines().next().expect("fixture must contain a record");
    serde_json::from_str(line).expect("fixture must be valid JSON")
}

#[test]
fn captured_handshake_has_the_documented_shape() {
    let value = fixture();
    assert_eq!(value["type"], "hello");
    assert_eq!(value["requestId"], "fixture-hello");
    assert!(value["scannerVersion"].is_string());

    let protocol: ProtocolVersion =
        serde_json::from_value(value["protocol"].clone()).expect("protocol object");
    assert_eq!(protocol.major, 1);

    let rules = value["capabilities"]["rules"]
        .as_array()
        .expect("capabilities.rules array");
    assert_eq!(rules.len(), RULES.len());
    for rule in rules {
        assert!(rule["id"].is_string());
        assert_eq!(rule["executor"], "native-text");
    }

    let features = value["capabilities"]["features"]
        .as_array()
        .expect("capabilities.features array");
    assert!(
        features
            .iter()
            .any(|feature| feature == "sha256-content-digest")
    );
}

#[test]
fn captured_options_are_fully_resolved() {
    let value = fixture();
    let options = &value["options"];
    // An unresolved option would let a client claim a limit the scan never used.
    for key in [
        "maxFiles",
        "maxBytesPerFile",
        "maxTotalBytes",
        "maxFindingsPerFile",
        "snippetBytes",
    ] {
        assert!(
            options[key].is_i64() || options[key].is_u64(),
            "{key} must be numeric"
        );
    }
    assert!(options["exclude"].is_array());
    assert!(options["rules"].is_array());
}
