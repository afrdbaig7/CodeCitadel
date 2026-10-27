//! The normalized finding record produced by passive text checks.
//!
//! Findings from the Rust scanner are always `suspected` evidence: a text
//! pattern that matched says nothing about reachability or data flow. The
//! TypeScript engine may upgrade evidence status later using AST or behavioral
//! checks, but the scanner never does.

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::rules::Executor;

/// Rule family. Kept separate from severity so consumers can filter either.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Category {
    Security,
    Secrets,
    Quality,
}

/// Impact if the finding is real. Independent of confidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Severity {
    Critical,
    High,
    Medium,
    Low,
    Info,
}

/// How much execution actually happened behind a finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceStatus {
    Suspected,
    Reproduced,
    UnableToVerify,
}

/// A source position in a single file.
///
/// `start_byte`/`end_byte` are UTF-8 byte offsets, which is what the Rust
/// scanner naturally has. Line and column are derived from those bytes:
/// 1-based lines, 1-based columns counted in UTF-16 code units to match
/// editor and TypeScript positions. Callers must not assume they are byte
/// columns.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub path: String,
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
    pub start_byte: u64,
    pub end_byte: u64,
    pub snippet: Option<String>,
    pub snippet_redacted: bool,
    pub snippet_truncated: bool,
}

/// One reported problem in one place.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    /// Stable fingerprint: survives unrelated line insertions in the same file.
    pub id: String,
    pub rule_id: String,
    pub rule_version: String,
    pub rule_title: String,
    pub category: Category,
    pub severity: Severity,
    pub executor: Executor,
    /// Text-rule confidence is bounded: the pattern matched, nothing more.
    pub confidence: Confidence,
    pub evidence_status: EvidenceStatus,
    pub message: String,
    pub explanation: String,
    pub remediation: String,
    pub references: Vec<String>,
    pub location: Location,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    Low,
    Medium,
    High,
}

/// Fingerprint inputs are the rule identity and the matched text, never the
/// line number, so inserting lines above a finding does not change its ID.
pub fn fingerprint(rule_id: &str, path: &str, matched_text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(rule_id.as_bytes());
    hasher.update([0u8]);
    hasher.update(path.as_bytes());
    hasher.update([0u8]);
    hasher.update(matched_text.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(19);
    out.push_str("f_");
    for byte in &digest[..8] {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// Byte offsets to 1-based line/UTF-16-column pairs.
pub struct LineIndex {
    /// Byte offset of the first character of each line.
    starts: Vec<usize>,
}

impl LineIndex {
    pub fn new(text: &str) -> Self {
        let mut starts = vec![0];
        for (offset, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(offset + 1);
            }
        }
        Self { starts }
    }

    /// Returns `(line, column)` for a byte offset at a UTF-8 character
    /// boundary. Offsets past the end clamp to the final line.
    pub fn locate(&self, text: &str, byte_offset: usize) -> (u32, u32) {
        let clamped = byte_offset.min(text.len());
        let line_index = match self.starts.binary_search(&clamped) {
            Ok(index) => index,
            Err(index) => index.saturating_sub(1),
        };
        let line_start = self.starts[line_index];
        let prefix = text.get(line_start..clamped).unwrap_or("");
        let column = prefix.chars().map(char::len_utf16).sum::<usize>() + 1;
        (line_index as u32 + 1, column as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_line_independent() {
        let first = fingerprint("native/x", "src/a.ts", "eval(");
        let second = fingerprint("native/x", "src/a.ts", "eval(");
        assert_eq!(first, second);
        assert!(first.starts_with("f_"));
        assert_eq!(first.len(), 18);
    }

    #[test]
    fn fingerprint_separates_paths() {
        assert_ne!(
            fingerprint("native/x", "src/a.ts", "eval("),
            fingerprint("native/x", "src/b.ts", "eval(")
        );
    }

    #[test]
    fn locates_ascii_lines() {
        let text = "one\ntwo\nthree";
        let index = LineIndex::new(text);
        assert_eq!(index.locate(text, 0), (1, 1));
        assert_eq!(index.locate(text, 4), (2, 1));
        assert_eq!(index.locate(text, 6), (2, 3));
    }

    #[test]
    fn locates_crlf_and_columns_are_utf16() {
        let text = "a\r\nb😀c";
        let index = LineIndex::new(text);
        assert_eq!(index.locate(text, 3), (2, 1));
        // "b" is one UTF-16 unit, the emoji is a surrogate pair.
        let emoji = 4;
        assert_eq!(index.locate(text, emoji), (2, 2));
        assert_eq!(index.locate(text, 8), (2, 4));
    }

    #[test]
    fn clamps_offsets_past_end() {
        let text = "abc";
        let index = LineIndex::new(text);
        assert_eq!(index.locate(text, 99), (1, 4));
    }
}
