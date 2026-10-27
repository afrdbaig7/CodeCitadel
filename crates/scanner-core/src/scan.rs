//! Scan orchestration: discovery -> bounded read -> digest -> text rules ->
//! normalized findings, emitted as protocol events.
//!
//! Execution order matters for honesty. A file that was skipped emits a
//! `skipped` reason and no findings; the summary separates `filesSeen` from
//! `filesScanned` so a caller cannot mistake "not looked at" for "clean".
//!
//! Scanning is passive: no repository configuration is parsed, no dependency is
//! installed, and no project program is spawned.

use std::io::{self, Write};
use std::path::Path;
use std::time::Instant;

use crate::discovery::discover;
use crate::finding::Finding;
use crate::hashing::{ReadError, read_bounded};
use crate::protocol::{
    Capabilities, DoneEvent, EffectiveOptions, ErrorEvent, FileEvent, FindingEvent, HelloEvent,
    ScanOptions, ScanRequest, ScanSummary, SeverityCounts, SkipReason, SummaryEvent, WarningEvent,
};
use crate::rules::{RuleSelection, check_text, describe_rules};
use crate::version::SCANNER_VERSION;

pub struct ScanOutcome {
    pub ok: bool,
    pub exit_code: i32,
    pub summary: ScanSummary,
}

fn emit<W: Write, T: serde::Serialize>(out: &mut W, value: &T) -> io::Result<()> {
    serde_json::to_writer(&mut *out, value).map_err(io::Error::other)?;
    out.write_all(b"\n")
}

fn effective_options(options: &ScanOptions) -> EffectiveOptions {
    let rules = match &options.rules {
        None => describe_rules()
            .iter()
            .map(|spec| spec.id.to_string())
            .collect(),
        Some(ids) => ids.clone(),
    };
    EffectiveOptions {
        max_files: options.max_files,
        max_bytes_per_file: options.max_bytes_per_file,
        max_total_bytes: options.max_total_bytes,
        max_findings_per_file: options.max_findings_per_file,
        snippet_bytes: options.snippet_bytes,
        include_hidden: options.include_hidden,
        follow_symlinks: options.follow_symlinks,
        exclude: options.exclude.clone(),
        rules,
    }
}

fn fatal<W: Write>(
    out: &mut W,
    request_id: &str,
    code: &'static str,
    message: String,
) -> io::Result<ScanOutcome> {
    emit(
        out,
        &ErrorEvent {
            kind: "error",
            request_id: request_id.to_string(),
            code,
            message,
            fatal: true,
        },
    )?;
    emit(
        out,
        &DoneEvent {
            kind: "done",
            request_id: request_id.to_string(),
            ok: false,
            exit_code: 2,
        },
    )?;
    Ok(ScanOutcome {
        ok: false,
        exit_code: 2,
        summary: ScanSummary::default(),
    })
}

pub fn scan<W: Write>(request: &ScanRequest, out: &mut W) -> io::Result<ScanOutcome> {
    let started = Instant::now();
    let root = Path::new(&request.root);
    let options = &request.options;

    let discovery = match discover(root, options) {
        Ok(discovery) => discovery,
        Err(error) => return fatal(out, &request.request_id, "invalid_root", error.to_string()),
    };

    emit(
        out,
        &HelloEvent {
            kind: "hello",
            request_id: request.request_id.clone(),
            scanner_version: SCANNER_VERSION.to_string(),
            protocol: request.protocol,
            root: root.display().to_string(),
            options: effective_options(options),
            capabilities: Capabilities {
                rules: describe_rules().into_iter().map(Into::into).collect(),
                features: vec![
                    "gitignore".to_string(),
                    "sha256-content-digest".to_string(),
                    "binary-detection".to_string(),
                    "bounded-reads".to_string(),
                    "deterministic-ordering".to_string(),
                ],
            },
        },
    )?;

    let mut summary = ScanSummary::default();
    let selection = RuleSelection::new(options.rules.clone());
    let mut findings_by_severity = SeverityCounts::default();

    for warning in &discovery.warnings {
        emit(
            out,
            &WarningEvent {
                kind: "warning",
                request_id: &request.request_id,
                code: warning.code,
                message: warning.message.clone(),
            },
        )?;
    }

    if discovery.truncated {
        summary.truncated = true;
        summary.limits_hit.push("maxFiles".to_string());
        emit(
            out,
            &WarningEvent {
                kind: "warning",
                request_id: &request.request_id,
                code: "max_files_truncated",
                message: format!(
                    "stopped after {} files; raise maxFiles to scan the whole repository",
                    options.max_files
                ),
            },
        )?;
    }

    for file in &discovery.files {
        // Check the declared size before reading: once the remaining budget
        // cannot cover a whole file we stop instead of analysing a truncated
        // file and reporting it as scanned.
        let declared_size = std::fs::metadata(&file.absolute_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let remaining = options.max_total_bytes.saturating_sub(summary.bytes_read);
        if declared_size > remaining {
            summary.truncated = true;
            summary.limits_hit.push("maxTotalBytes".to_string());
            emit(
                out,
                &WarningEvent {
                    kind: "warning",
                    request_id: &request.request_id,
                    code: "max_total_bytes_truncated",
                    message: format!(
                        "stopped at {} bytes; raise maxTotalBytes to scan the whole repository",
                        summary.bytes_read
                    ),
                },
            )?;
            break;
        }

        let limit = options.max_bytes_per_file.min(remaining);
        summary.files_seen += 1;

        let file_bytes = match read_bounded(&file.absolute_path, limit) {
            Ok(file_bytes) => file_bytes,
            Err(ReadError::TooLarge { .. }) => {
                summary.files_skipped += 1;
                emit(
                    out,
                    &FileEvent {
                        kind: "file",
                        request_id: request.request_id.clone(),
                        path: file.relative_path.clone(),
                        size_bytes: std::fs::metadata(&file.absolute_path)
                            .map(|meta| meta.len())
                            .unwrap_or(0),
                        digest: None,
                        skipped: Some(SkipReason::TooLarge),
                    },
                )?;
                continue;
            }
            Err(ReadError::Io(_)) => {
                summary.files_skipped += 1;
                emit(
                    out,
                    &FileEvent {
                        kind: "file",
                        request_id: request.request_id.clone(),
                        path: file.relative_path.clone(),
                        size_bytes: 0,
                        digest: None,
                        skipped: Some(SkipReason::Unreadable),
                    },
                )?;
                continue;
            }
        };

        summary.bytes_read += file_bytes.bytes.len() as u64;

        if file_bytes.binary {
            summary.files_skipped += 1;
            emit(
                out,
                &FileEvent {
                    kind: "file",
                    request_id: request.request_id.clone(),
                    path: file.relative_path.clone(),
                    size_bytes: file_bytes.bytes.len() as u64,
                    digest: Some(file_bytes.digest),
                    skipped: Some(SkipReason::Binary),
                },
            )?;
            continue;
        }

        let text = match std::str::from_utf8(&file_bytes.bytes) {
            Ok(text) => text,
            Err(_) => {
                summary.files_skipped += 1;
                emit(
                    out,
                    &FileEvent {
                        kind: "file",
                        request_id: request.request_id.clone(),
                        path: file.relative_path.clone(),
                        size_bytes: file_bytes.bytes.len() as u64,
                        digest: Some(file_bytes.digest),
                        skipped: Some(SkipReason::NonUtf8),
                    },
                )?;
                continue;
            }
        };

        summary.files_scanned += 1;
        emit(
            out,
            &FileEvent {
                kind: "file",
                request_id: request.request_id.clone(),
                path: file.relative_path.clone(),
                size_bytes: file_bytes.bytes.len() as u64,
                digest: Some(file_bytes.digest),
                skipped: None,
            },
        )?;

        let findings: Vec<Finding> = check_text(
            &file.relative_path,
            text,
            &selection,
            options.max_findings_per_file,
            options.snippet_bytes,
        );
        for finding in &findings {
            findings_by_severity.record(finding.severity);
            emit(
                out,
                &FindingEvent {
                    kind: "finding",
                    request_id: &request.request_id,
                    finding,
                },
            )?;
        }
        summary.findings += findings.len() as u64;
    }

    summary.findings_by_severity = findings_by_severity;
    summary.duration_ms = started.elapsed().as_millis() as u64;

    emit(
        out,
        &SummaryEvent {
            kind: "summary",
            request_id: request.request_id.clone(),
            summary: summary.clone(),
        },
    )?;
    emit(
        out,
        &DoneEvent {
            kind: "done",
            request_id: request.request_id.clone(),
            ok: true,
            exit_code: 0,
        },
    )?;

    Ok(ScanOutcome {
        ok: true,
        exit_code: 0,
        summary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ProtocolVersion, ScanOptions};
    use std::fs;

    fn run(root: &Path, options: ScanOptions) -> (Vec<serde_json::Value>, ScanOutcome) {
        let request = ScanRequest {
            request_id: "test".to_string(),
            protocol: ProtocolVersion::default(),
            root: root.display().to_string(),
            options,
        };
        let mut buffer = Vec::new();
        let outcome = scan(&request, &mut buffer).expect("scan");
        let text = String::from_utf8(buffer).expect("utf8");
        let events = text
            .lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).expect("json"))
            .collect();
        (events, outcome)
    }

    fn event_types(events: &[serde_json::Value]) -> Vec<String> {
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap_or("?").to_string())
            .collect()
    }

    #[test]
    fn streams_hello_then_done_and_is_deterministic() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::create_dir_all(dir.path().join("src")).expect("mkdir");
        fs::write(dir.path().join("src/b.ts"), "TODO\n").expect("write");
        fs::write(dir.path().join("src/a.ts"), "export const a = 1;\n").expect("write");

        let (first, outcome) = run(dir.path(), ScanOptions::default());
        let types = event_types(&first);
        assert_eq!(types.first().map(String::as_str), Some("hello"));
        assert_eq!(types.last().map(String::as_str), Some("done"));
        assert!(outcome.ok);
        assert_eq!(outcome.exit_code, 0);

        let paths: Vec<String> = first
            .iter()
            .filter(|event| event["type"] == "file")
            .filter_map(|event| event["path"].as_str().map(str::to_string))
            .collect();
        assert_eq!(paths, vec!["src/a.ts", "src/b.ts"]);

        let (second, _) = run(dir.path(), ScanOptions::default());
        let finding_ids = |events: &[serde_json::Value]| {
            events
                .iter()
                .filter(|event| event["type"] == "finding")
                .map(|event| event["finding"]["id"].as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>()
        };
        assert_eq!(finding_ids(&first), finding_ids(&second));
    }

    #[test]
    fn missing_root_is_fatal_and_not_a_clean_scan() {
        let (events, outcome) = run(Path::new("./not-here-42"), ScanOptions::default());
        assert!(!outcome.ok);
        assert_eq!(outcome.exit_code, 2);
        let types = event_types(&events);
        assert_eq!(types, vec!["error", "done"]);
        assert_eq!(events[0]["code"], "invalid_root");
        assert_eq!(events[1]["ok"], false);
    }

    #[test]
    fn skipped_binary_file_is_counted_separately_from_scanned() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join("image.bin"), [0u8, 1, 2, 3]).expect("write");
        fs::write(dir.path().join("a.ts"), "export const a = 1;\n").expect("write");

        let (events, outcome) = run(dir.path(), ScanOptions::default());
        let summary = &outcome.summary;
        assert_eq!(summary.files_scanned, 1);
        assert_eq!(summary.files_skipped, 1);
        let binary = events
            .iter()
            .find(|event| event["path"] == "image.bin")
            .expect("binary record");
        assert_eq!(binary["skipped"], "binary");
    }

    #[test]
    fn total_byte_budget_marks_the_summary_truncated() {
        let dir = tempfile::tempdir().expect("tempdir");
        for index in 0..4 {
            fs::write(dir.path().join(format!("f{index}.ts")), "x".repeat(100)).expect("write");
        }
        let options = ScanOptions {
            max_total_bytes: 250,
            ..ScanOptions::default()
        };
        let (events, outcome) = run(dir.path(), options);
        assert!(outcome.summary.truncated);
        assert!(
            outcome
                .summary
                .limits_hit
                .contains(&"maxTotalBytes".to_string())
        );
        assert!(event_types(&events).iter().any(|kind| kind == "warning"));
    }

    #[test]
    fn secrets_are_redacted_in_emitted_events() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(
            dir.path().join("config.ts"),
            "const key = 'AKIAIOSFODNN7EXAMPLE';\n",
        )
        .expect("write");
        let (events, _) = run(dir.path(), ScanOptions::default());
        let raw = serde_json::to_string(&events).expect("json");
        assert!(
            !raw.contains("AKIAIOSFODNN7EXAMPLE"),
            "secret leaked in event stream"
        );
    }
}
