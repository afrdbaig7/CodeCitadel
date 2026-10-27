//! Native text rules executed inside the scanner.
//!
//! These rules are deliberately few and narrow. A regex can prove that a
//! literal pattern appears in a file; it cannot prove data flow, reachability,
//! or that the pattern is a defect. Rules whose correctness needs syntax or
//! types belong to the TypeScript AST executor, not here.

use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

use crate::finding::{
    Category, Confidence, EvidenceStatus, Finding, LineIndex, Location, Severity, fingerprint,
};

/// Which executor owns a rule. One canonical rule ID exists per rule; a rule
/// is never re-implemented in both engines.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Executor {
    NativeText,
}

/// Static description of a rule, also published in the `hello` capability
/// message so clients never guess which rules the binary can run.
pub struct RuleSpec {
    pub id: &'static str,
    pub version: &'static str,
    pub title: &'static str,
    pub category: Category,
    pub severity: Severity,
    pub confidence: Confidence,
    pub executor: Executor,
    pub languages: &'static [&'static str],
    pub file_extensions: &'static [&'static str],
    pub explanation: &'static str,
    pub remediation: &'static str,
    pub references: &'static [&'static str],
    /// Secret-like rules never echo the matched text into a report.
    pub redact: bool,
    pub pattern: &'static str,
}

pub const RULES: &[RuleSpec] = &[
    RuleSpec {
        id: "secrets/aws-access-key-id",
        version: "1.0.0",
        title: "AWS access key ID in source",
        category: Category::Secrets,
        severity: Severity::High,
        confidence: Confidence::High,
        executor: Executor::NativeText,
        languages: &["*"],
        file_extensions: &[
            "ts", "tsx", "js", "jsx", "mjs", "cjs", "json", "yaml", "yml", "env", "ini", "toml",
            "md", "txt",
        ],
        explanation: "A 20-character string matching the AWS access key ID format appears in a file. \
Access key IDs are credentials: anyone who reads the repository may be able to use them.",
        remediation: "Revoke the key in IAM, then load the replacement from the environment or a secret manager. \
Rotate first: removing the line does not un-leak the credential.",
        references: &[
            "https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html",
        ],
        redact: true,
        pattern: r"AKIA[0-9A-Z]{16}",
    },
    RuleSpec {
        id: "secrets/private-key-material",
        version: "1.0.0",
        title: "Private key material committed to the repository",
        category: Category::Secrets,
        severity: Severity::Critical,
        confidence: Confidence::High,
        executor: Executor::NativeText,
        languages: &["*"],
        file_extensions: &[
            "pem", "key", "crt", "txt", "env", "ini", "yaml", "yml", "json", "ts", "js",
        ],
        explanation: "A PEM private key header appears in a tracked file. \
A committed private key must be treated as compromised even if the commit is later amended.",
        remediation: "Rotate the key pair, remove the material from the repository, and load keys from a \
secret store or local untracked path.",
        references: &["https://cwe.mitre.org/data/definitions/321.html"],
        redact: true,
        pattern: r"-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----",
    },
    RuleSpec {
        id: "security/tls-verification-disabled",
        version: "1.0.0",
        title: "TLS certificate verification disabled",
        category: Category::Security,
        severity: Severity::High,
        confidence: Confidence::Medium,
        executor: Executor::NativeText,
        languages: &["javascript", "typescript"],
        file_extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
        explanation: "The file turns off certificate verification. Traffic that should fail on an invalid \
certificate is instead accepted, which removes protection against interception.",
        remediation: "Remove the override. For local development, trust a development CA instead of disabling \
verification, and never ship the override in production code paths.",
        references: &["https://cwe.mitre.org/data/definitions/295.html"],
        redact: false,
        pattern: r#"rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"]0['\"]"#,
    },
    RuleSpec {
        id: "security/dangerous-html-sink",
        version: "1.0.0",
        title: "Unescaped HTML injection sink",
        category: Category::Security,
        severity: Severity::Medium,
        confidence: Confidence::Low,
        executor: Executor::NativeText,
        languages: &["javascript", "typescript"],
        file_extensions: &["ts", "tsx", "js", "jsx"],
        explanation: "Raw HTML is written into the DOM. This is only a defect when the value can carry \
untrusted input; text matching cannot decide that, so evidence stays `suspected`.",
        remediation: "Render text through normal escaping, or sanitize the HTML at the boundary with a \
maintained sanitizer before it reaches the sink.",
        references: &["https://cwe.mitre.org/data/definitions/79.html"],
        redact: false,
        pattern: r"dangerouslySetInnerHTML",
    },
    RuleSpec {
        id: "security/shell-enabled-subprocess",
        version: "1.0.0",
        title: "Subprocess spawned with a shell",
        category: Category::Security,
        severity: Severity::Medium,
        confidence: Confidence::Low,
        executor: Executor::NativeText,
        languages: &["javascript", "typescript"],
        file_extensions: &["ts", "tsx", "js", "jsx", "mjs", "cjs"],
        explanation: "A process is spawned with shell interpretation enabled. If an interpolated argument \
reaches it, shell metacharacters become executable syntax.",
        remediation: "Spawn with an argument array and leave the shell disabled; pass user input as arguments, \
not as command text.",
        references: &["https://cwe.mitre.org/data/definitions/78.html"],
        redact: false,
        pattern: r"\bshell\s*:\s*true\b",
    },
    RuleSpec {
        id: "quality/committed-todo-marker",
        version: "1.0.0",
        title: "Unresolved task marker",
        category: Category::Quality,
        severity: Severity::Info,
        confidence: Confidence::High,
        executor: Executor::NativeText,
        languages: &["*"],
        file_extensions: &["ts", "tsx", "js", "jsx", "rs", "py", "go", "java", "kt"],
        explanation: "A `TODO`/`FIXME` marker was found. This is a bookkeeping observation, not a bug: it is \
reported so the total is visible, not scored.",
        remediation: "Convert the note into a tracked issue, or delete the stale note.",
        references: &[],
        redact: false,
        pattern: r"\b(?:TODO|FIXME)\b",
    },
];

struct CompiledRule {
    spec: &'static RuleSpec,
    regex: Regex,
}

static COMPILED: LazyLock<Vec<CompiledRule>> = LazyLock::new(|| {
    RULES
        .iter()
        .map(|spec| CompiledRule {
            spec,
            // Patterns are constant and covered by tests, so a compile failure
            // is a programming error rather than user input.
            regex: Regex::new(spec.pattern).expect("rule pattern must compile"),
        })
        .collect()
});

/// Filter for the `rules` scan option: `None` means every rule is enabled.
pub struct RuleSelection {
    enabled: Option<Vec<String>>,
}

impl RuleSelection {
    pub fn new(enabled: Option<Vec<String>>) -> Self {
        Self { enabled }
    }

    fn allows(&self, rule_id: &str) -> bool {
        match &self.enabled {
            None => true,
            Some(ids) => ids.iter().any(|id| id == rule_id),
        }
    }
}

/// Rule metadata for the capability handshake.
pub fn describe_rules() -> Vec<&'static RuleSpec> {
    RULES.iter().collect()
}

fn extension_of(path: &str) -> &str {
    let file_name = path.rsplit(['/', '\\']).next().unwrap_or(path);
    // `.env` has an empty stem but a meaningful extension; a dotless name does not.
    match file_name.rsplit_once('.') {
        Some((_, ext)) => ext,
        None => "",
    }
}

fn snippet_for(
    text: &str,
    start: usize,
    end: usize,
    redact: bool,
    limit: usize,
) -> (String, bool, bool) {
    if redact {
        // Keep the surrounding context but never the secret itself.
        let line_start = text[..start].rfind('\n').map_or(0, |index| index + 1);
        let line_end = text[end..]
            .find('\n')
            .map_or(text.len(), |index| end + index);
        let mut context = String::from(&text[line_start..start]);
        context.push_str("[redacted]");
        context.push_str(&text[end..line_end]);
        let truncated = context.len() > limit;
        return (truncate(context, limit), true, truncated);
    }
    let matched = &text[start..end];
    let truncated = matched.len() > limit;
    (truncate(matched.to_string(), limit), false, truncated)
}

fn truncate(mut value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut cut = limit;
    while cut > 0 && !value.is_char_boundary(cut) {
        cut -= 1;
    }
    value.truncate(cut);
    value
}

/// Runs every enabled rule against one decoded file.
///
/// At most one finding per rule per line is emitted: repeated matches usually
/// describe the same location, and repeating them inflates the report without
/// adding information. `max_findings` bounds the output per file.
pub fn check_text(
    path: &str,
    text: &str,
    selection: &RuleSelection,
    max_findings: usize,
    snippet_limit: usize,
) -> Vec<Finding> {
    let extension = extension_of(path);
    let index = LineIndex::new(text);
    let mut findings = Vec::new();

    'rules: for rule in COMPILED.iter() {
        if !selection.allows(rule.spec.id) {
            continue;
        }
        if !rule.spec.file_extensions.is_empty() && !rule.spec.file_extensions.contains(&extension)
        {
            continue;
        }
        let mut last_line = 0u32;
        for capture in rule.regex.find_iter(text) {
            if capture.start() == capture.end() {
                continue;
            }
            let (line, column) = index.locate(text, capture.start());
            if line == last_line {
                continue;
            }
            last_line = line;
            let (end_line, end_column_offset) = index.locate(text, capture.end());
            let (snippet, redacted, snippet_truncated) = snippet_for(
                text,
                capture.start(),
                capture.end(),
                rule.spec.redact,
                snippet_limit,
            );
            findings.push(Finding {
                id: fingerprint(rule.spec.id, path, capture.as_str()),
                rule_id: rule.spec.id.to_string(),
                rule_version: rule.spec.version.to_string(),
                rule_title: rule.spec.title.to_string(),
                category: rule.spec.category,
                severity: rule.spec.severity,
                executor: rule.spec.executor,
                confidence: rule.spec.confidence,
                evidence_status: EvidenceStatus::Suspected,
                message: rule.spec.title.to_string(),
                explanation: rule.spec.explanation.to_string(),
                remediation: rule.spec.remediation.to_string(),
                references: rule
                    .spec
                    .references
                    .iter()
                    .map(|value| value.to_string())
                    .collect(),
                location: Location {
                    path: path.to_string(),
                    start_line: line,
                    start_column: column,
                    end_line,
                    end_column: end_column_offset,
                    start_byte: capture.start() as u64,
                    end_byte: capture.end() as u64,
                    snippet: Some(snippet),
                    snippet_redacted: redacted,
                    snippet_truncated,
                },
            });
            if findings.len() >= max_findings {
                break 'rules;
            }
        }
    }

    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(path: &str, text: &str) -> Vec<Finding> {
        check_text(path, text, &RuleSelection::new(None), 50, 160)
    }

    #[test]
    fn every_rule_pattern_compiles() {
        assert!(!COMPILED.is_empty());
        for rule in COMPILED.iter() {
            assert!(!rule.spec.id.is_empty());
            assert!(!rule.spec.explanation.is_empty());
        }
    }

    #[test]
    fn detects_aws_key_and_redacts_it() {
        let text = "const key = \"AKIAIOSFODNN7EXAMPLE\";\n";
        let findings = check("src/config.ts", text);
        let finding = findings
            .iter()
            .find(|item| item.rule_id == "secrets/aws-access-key-id")
            .expect("aws key finding");
        let snippet = finding.location.snippet.as_deref().unwrap_or_default();
        assert!(finding.location.snippet_redacted);
        assert!(!snippet.contains("AKIAIOSFODNN7EXAMPLE"));
        assert!(snippet.contains("[redacted]"));
        assert_eq!(finding.location.start_line, 1);
        assert_eq!(finding.evidence_status, EvidenceStatus::Suspected);
    }

    #[test]
    fn clean_control_text_has_no_secret_findings() {
        let text = "export const region = \"us-east-1\";\n";
        let findings = check("src/config.ts", text);
        assert!(
            findings
                .iter()
                .all(|item| item.category != Category::Secrets)
        );
    }

    #[test]
    fn skips_extensions_the_rule_does_not_support() {
        let text = "rejectUnauthorized: false\n";
        assert!(
            check("config.yaml", text)
                .iter()
                .all(|item| item.rule_id != "security/tls-verification-disabled")
        );
        assert!(
            check("config.ts", text)
                .iter()
                .any(|item| item.rule_id == "security/tls-verification-disabled")
        );
    }

    #[test]
    fn emits_one_finding_per_line() {
        let text = "TODO one TODO two\nTODO three\n";
        let findings = check("src/a.ts", text)
            .into_iter()
            .filter(|item| item.rule_id == "quality/committed-todo-marker")
            .count();
        assert_eq!(findings, 2);
    }

    #[test]
    fn respects_rule_selection() {
        let text = "TODO\n";
        let selection = RuleSelection::new(Some(vec!["secrets/aws-access-key-id".to_string()]));
        let findings = check_text("src/a.ts", text, &selection, 50, 160);
        assert!(findings.is_empty());
    }

    #[test]
    fn bounds_findings_per_file() {
        let text = (0..20)
            .map(|seed| format!("// TODO {seed}\n"))
            .collect::<String>();
        let findings = check_text("src/a.ts", &text, &RuleSelection::new(None), 3, 160);
        assert_eq!(findings.len(), 3);
    }

    #[test]
    fn handles_emoji_offsets_without_panicking() {
        let text = "const face = \"😀\"; const bad = \"AKIAIOSFODNN7EXAMPLE\";\n";
        let findings = check("src/a.tsx", text);
        let finding = findings
            .iter()
            .find(|item| item.rule_id == "secrets/aws-access-key-id")
            .expect("aws key finding");
        // The emoji earlier on the line counts as two UTF-16 units.
        assert!(finding.location.start_column > 20);
    }
}
