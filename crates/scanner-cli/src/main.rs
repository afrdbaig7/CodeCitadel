//! Thin executable around `scanner-core`.
//!
//! Deliberately boring: parse one request from stdin, stream records to stdout,
//! exit with the scan's exit code. All decisions live in the library so the
//! same behavior can be tested without spawning a process.
//!
//! stdout carries only newline-delimited JSON. Human diagnostics go to stderr.
//! A malformed request produces `error` + `done` records and exit code 2.

use std::io::{self, BufRead, BufWriter, Write};
use std::process::ExitCode;

use clap::Parser;
use scanner_core::describe_rules;
use scanner_core::protocol::{
    DoneEvent, ErrorEvent, PROTOCOL_MAJOR, PROTOCOL_MINOR, Request, RuleSummary,
};
use scanner_core::scan;
use scanner_core::version::SCANNER_VERSION;

#[derive(Debug, Parser)]
#[command(
    name = "codecitadel-scanner",
    version,
    about = "Passive repository scanner for CodeCitadel. Reads one NDJSON request from stdin."
)]
struct Cli {
    /// Print the capability handshake as JSON and exit without scanning.
    #[arg(long)]
    capabilities: bool,
}

const FEATURES: &[&str] = &[
    "gitignore",
    "sha256-content-digest",
    "binary-detection",
    "bounded-reads",
    "deterministic-ordering",
];

fn main() -> ExitCode {
    let cli = Cli::parse();
    let stdout = io::stdout();
    let mut out = BufWriter::new(stdout.lock());

    if cli.capabilities {
        return match write_capabilities(&mut out) {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("codecitadel-scanner: cannot write capabilities: {error}");
                ExitCode::from(2)
            }
        };
    }

    let stdin = io::stdin();
    let mut saw_request = false;
    let mut exit_code = 0;

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("codecitadel-scanner: cannot read stdin: {error}");
                return ExitCode::from(2);
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request: Request = match serde_json::from_str(&line) {
            Ok(request) => request,
            Err(error) => {
                let _ = write_fatal(&mut out, "", "invalid_request", error.to_string());
                return ExitCode::from(2);
            }
        };

        saw_request = true;
        let Request::Scan(scan_request) = request;

        if let Err(error) = scanner_core::protocol::protocol_compatible(scan_request.protocol) {
            let _ = write_fatal(
                &mut out,
                &scan_request.request_id,
                "incompatible_protocol",
                error,
            );
            return ExitCode::from(2);
        }

        match scan(&scan_request, &mut out) {
            Ok(outcome) => exit_code = outcome.exit_code,
            Err(error) => {
                eprintln!("codecitadel-scanner: cannot write scan output: {error}");
                return ExitCode::from(2);
            }
        }
    }

    if !saw_request {
        eprintln!("codecitadel-scanner: no scan request on stdin");
        let _ = write_fatal(
            &mut out,
            "",
            "no_request",
            "expected one scan request line on stdin".to_string(),
        );
        return ExitCode::from(2);
    }

    match out.flush() {
        Ok(()) => ExitCode::from(exit_code as u8),
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("codecitadel-scanner: cannot flush stdout: {error}");
            ExitCode::from(2)
        }
    }
}

fn write_capabilities<W: Write>(out: &mut W) -> io::Result<()> {
    let rules = describe_rules()
        .into_iter()
        .map(RuleSummary::from)
        .collect::<Vec<_>>();
    let payload = serde_json::json!({
        "type": "capabilities",
        "scannerVersion": SCANNER_VERSION,
        "protocol": { "major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR },
        "features": FEATURES,
        "rules": rules,
    });
    serde_json::to_writer(&mut *out, &payload)?;
    out.write_all(b"\n")?;
    out.flush()
}

fn write_fatal<W: Write>(
    out: &mut W,
    request_id: &str,
    code: &'static str,
    message: String,
) -> io::Result<()> {
    let error = ErrorEvent {
        kind: "error",
        request_id: request_id.to_string(),
        code,
        message,
        fatal: true,
    };
    serde_json::to_writer(&mut *out, &error)?;
    out.write_all(b"\n")?;
    let done = DoneEvent {
        kind: "done",
        request_id: request_id.to_string(),
        ok: false,
        exit_code: 2,
    };
    serde_json::to_writer(&mut *out, &done)?;
    out.write_all(b"\n")?;
    out.flush()
}
