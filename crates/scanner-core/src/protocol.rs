//! Versioned newline-delimited JSON protocol spoken over stdin/stdout.
//!
//! One request per process invocation: the client writes a single `scan`
//! request line, the scanner streams records, and the stream ends with exactly
//! one `done` record. Diagnostics go to stderr, never stdout, so a consumer can
//! validate every stdout line as JSON.
//!
//! A stream that ends without `done` is incomplete: a killed scanner is not a
//! clean scan. Clients must treat that as an error, never as "no findings".

use serde::{Deserialize, Serialize};

use crate::finding::{Category, Severity};
use crate::rules::{Executor, RuleSpec};

pub const PROTOCOL_MAJOR: u32 = 1;
pub const PROTOCOL_MINOR: u32 = 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolVersion {
    pub major: u32,
    pub minor: u32,
}

impl Default for ProtocolVersion {
    fn default() -> Self {
        Self {
            major: PROTOCOL_MAJOR,
            minor: PROTOCOL_MINOR,
        }
    }
}

/// Bounded defaults. Every limit is echoed back in `hello` so the client can
/// show what the scan actually enforced.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ScanOptions {
    pub max_files: usize,
    pub max_bytes_per_file: u64,
    pub max_total_bytes: u64,
    pub max_findings_per_file: usize,
    pub snippet_bytes: usize,
    pub include_hidden: bool,
    pub follow_symlinks: bool,
    /// Gitignore-style exclusion globs applied on top of repository ignore rules.
    pub exclude: Vec<String>,
    /// `None` runs every rule the scanner publishes.
    pub rules: Option<Vec<String>>,
}

impl Default for ScanOptions {
    fn default() -> Self {
        Self {
            max_files: 20_000,
            max_bytes_per_file: 1_048_576,
            max_total_bytes: 134_217_728,
            max_findings_per_file: 50,
            snippet_bytes: 160,
            include_hidden: false,
            follow_symlinks: false,
            exclude: Vec::new(),
            rules: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanRequest {
    pub request_id: String,
    #[serde(default)]
    pub protocol: ProtocolVersion,
    pub root: String,
    #[serde(default)]
    pub options: ScanOptions,
}

/// A line on stdin. Unknown request types are rejected explicitly instead of
/// being ignored, so a client/version mismatch surfaces immediately.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Request {
    Scan(ScanRequest),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSummary {
    pub id: String,
    pub version: String,
    pub title: String,
    pub category: Category,
    pub severity: Severity,
    pub executor: Executor,
    pub languages: Vec<String>,
    pub explanation: String,
    pub remediation: String,
    pub references: Vec<String>,
}

impl From<&RuleSpec> for RuleSummary {
    fn from(spec: &RuleSpec) -> Self {
        Self {
            id: spec.id.to_string(),
            version: spec.version.to_string(),
            title: spec.title.to_string(),
            category: spec.category,
            severity: spec.severity,
            executor: spec.executor,
            languages: spec
                .languages
                .iter()
                .map(|value| value.to_string())
                .collect(),
            explanation: spec.explanation.to_string(),
            remediation: spec.remediation.to_string(),
            references: spec
                .references
                .iter()
                .map(|value| value.to_string())
                .collect(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub rules: Vec<RuleSummary>,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub scanner_version: String,
    pub protocol: ProtocolVersion,
    pub root: String,
    pub options: EffectiveOptions,
    pub capabilities: Capabilities,
}

/// The options the scan actually used, after defaults were applied.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveOptions {
    pub max_files: usize,
    pub max_bytes_per_file: u64,
    pub max_total_bytes: u64,
    pub max_findings_per_file: usize,
    pub snippet_bytes: usize,
    pub include_hidden: bool,
    pub follow_symlinks: bool,
    pub exclude: Vec<String>,
    pub rules: Vec<String>,
}

/// Why a discovered path produced no content. Reported, never silently dropped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    Binary,
    TooLarge,
    NonUtf8,
    Unreadable,
    NotAFile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub path: String,
    pub size_bytes: u64,
    pub digest: Option<String>,
    pub skipped: Option<SkipReason>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindingEvent<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: &'a str,
    pub finding: &'a crate::finding::Finding,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WarningEvent<'a> {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: &'a str,
    pub code: &'a str,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSummary {
    pub files_seen: u64,
    pub files_scanned: u64,
    pub files_skipped: u64,
    pub bytes_read: u64,
    pub findings: u64,
    pub findings_by_severity: SeverityCounts,
    /// True when a limit stopped the scan early. A truncated scan is not a
    /// complete scan and clients must surface that.
    pub truncated: bool,
    pub limits_hit: Vec<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeverityCounts {
    pub critical: u64,
    pub high: u64,
    pub medium: u64,
    pub low: u64,
    pub info: u64,
}

impl SeverityCounts {
    pub fn record(&mut self, severity: Severity) {
        match severity {
            Severity::Critical => self.critical += 1,
            Severity::High => self.high += 1,
            Severity::Medium => self.medium += 1,
            Severity::Low => self.low += 1,
            Severity::Info => self.info += 1,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub summary: ScanSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub ok: bool,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEvent {
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub request_id: String,
    pub code: &'static str,
    pub message: String,
    /// Validation failures are the caller's fault; not a partial scan.
    pub fatal: bool,
}

pub fn protocol_compatible(version: ProtocolVersion) -> Result<(), String> {
    if version.major != PROTOCOL_MAJOR {
        return Err(format!(
            "incompatible protocol major: client requested {}.x, scanner speaks {}.x",
            version.major, PROTOCOL_MAJOR
        ));
    }
    Ok(())
}
