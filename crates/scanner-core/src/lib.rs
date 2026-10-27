//! CodeCitadel passive repository scanner.
//!
//! The crate owns file discovery, content digests, and bounded text checks. It
//! does not execute repository code, resolve TypeScript types, or decide
//! whether a finding is a real defect. See `docs/architecture.md`.

pub mod discovery;
pub mod finding;
pub mod hashing;
pub mod protocol;
pub mod rules;
pub mod scan;
pub mod version;

pub use discovery::{DiscoveredFile, Discovery, DiscoveryError, DiscoveryWarning, discover};
pub use finding::{Category, Confidence, EvidenceStatus, Finding, Location, Severity};
pub use hashing::{
    DIGEST_SCHEMA_VERSION, FileBytes, ReadError, hex_sha256, looks_binary, read_bounded,
};
pub use protocol::{
    PROTOCOL_MAJOR, PROTOCOL_MINOR, ProtocolVersion, ScanOptions, ScanRequest, ScanSummary,
};
pub use rules::{Executor, RULES, RuleSelection, RuleSpec, check_text, describe_rules};
pub use scan::{ScanOutcome, scan};
pub use version::SCANNER_VERSION;
