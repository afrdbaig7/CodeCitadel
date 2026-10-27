//! Repository file discovery.
//!
//! Precedence, highest first:
//! 1. The explicit scan root (symlinks are not followed outside it by default).
//! 2. Explicit `exclude` globs from the request.
//! 3. Repository ignore rules: `.gitignore`, `.git/info/exclude`, global ignores.
//! 4. Hidden-file skipping, unless `includeHidden` is set.
//! 5. `maxFiles`.
//!
//! Discovery never executes repository code and never reads project
//! configuration. It lists names, sizes, and whether the entry is a regular
//! file; reading is a separate, bounded step.

use std::path::{Path, PathBuf};

use ignore::WalkBuilder;
use ignore::overrides::OverrideBuilder;

use crate::protocol::ScanOptions;

/// A regular file inside the scan root, identified relative to it.
#[derive(Debug, Clone)]
pub struct DiscoveredFile {
    pub relative_path: String,
    pub absolute_path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct DiscoveryWarning {
    pub code: &'static str,
    pub message: String,
}

#[derive(Debug, Clone, Default)]
pub struct Discovery {
    pub files: Vec<DiscoveredFile>,
    pub warnings: Vec<DiscoveryWarning>,
    /// True when `maxFiles` cut the walk short.
    pub truncated: bool,
    /// Entries the walker produced, including ones we could not represent.
    pub entries_seen: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("scan root does not exist: {0}")]
    RootMissing(String),
    #[error("scan root is not a directory: {0}")]
    RootNotDirectory(String),
    #[error("cannot resolve scan root {root}: {message}")]
    RootUnreadable { root: String, message: String },
    #[error("invalid exclude glob {pattern}: {message}")]
    InvalidExclude { pattern: String, message: String },
}

/// Converts a path to a forward-slash relative path.
///
/// Returns `None` for paths that are not valid UTF-8. Lossy conversion could
/// map two different files onto one reported path, so those entries are
/// skipped with a warning instead.
fn relative_utf8_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let mut segments = Vec::new();
    for component in relative.components() {
        segments.push(component.as_os_str().to_str()?.to_string());
    }
    Some(segments.join("/"))
}

pub fn discover(root: &Path, options: &ScanOptions) -> Result<Discovery, DiscoveryError> {
    if !root.exists() {
        return Err(DiscoveryError::RootMissing(root.display().to_string()));
    }
    if !root.is_dir() {
        return Err(DiscoveryError::RootNotDirectory(root.display().to_string()));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| DiscoveryError::RootUnreadable {
            root: root.display().to_string(),
            message: error.to_string(),
        })?;

    let mut overrides = OverrideBuilder::new(&canonical_root);
    for pattern in &options.exclude {
        // In the `ignore` crate a `!` prefix marks an exclusion.
        overrides
            .add(&format!("!{pattern}"))
            .map_err(|error| DiscoveryError::InvalidExclude {
                pattern: pattern.clone(),
                message: error.to_string(),
            })?;
    }
    let overrides = overrides
        .build()
        .map_err(|error| DiscoveryError::InvalidExclude {
            pattern: options.exclude.join(", "),
            message: error.to_string(),
        })?;

    let mut builder = WalkBuilder::new(&canonical_root);
    builder
        .hidden(!options.include_hidden)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // A scanner often runs on an exported directory or a snapshot without a
        // `.git` folder. Ignore rules should still apply there.
        .require_git(false)
        .parents(true)
        .follow_links(options.follow_symlinks)
        .overrides(overrides)
        .max_filesize(Some(options.max_bytes_per_file));

    let mut discovery = Discovery::default();
    for entry in builder.build() {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                discovery.warnings.push(DiscoveryWarning {
                    code: "walk_error",
                    message: error.to_string(),
                });
                continue;
            }
        };
        discovery.entries_seen += 1;
        let path = entry.path();
        let file_type = match entry.file_type() {
            Some(file_type) => file_type,
            None => continue,
        };
        if !file_type.is_file() {
            continue;
        }
        let Some(relative_path) = relative_utf8_path(&canonical_root, path) else {
            discovery.warnings.push(DiscoveryWarning {
                code: "non_utf8_path",
                message: format!("skipped a path that is not valid UTF-8: {}", path.display()),
            });
            continue;
        };
        if discovery.files.len() >= options.max_files {
            discovery.truncated = true;
            break;
        }
        discovery.files.push(DiscoveredFile {
            relative_path,
            absolute_path: path.to_path_buf(),
        });
    }

    // Deterministic output: parallel walk order is not stable across platforms.
    discovery
        .files
        .sort_by(|left, right| left.relative_path.cmp(&right.relative_path));
    Ok(discovery)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn options() -> ScanOptions {
        ScanOptions::default()
    }

    #[test]
    fn respects_gitignore_and_skips_node_modules() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::create_dir_all(root.join("node_modules/pkg")).expect("mkdir");
        fs::write(root.join(".gitignore"), "node_modules/\nsecret.txt\n").expect("write");
        fs::write(root.join("src/index.ts"), "export const a = 1;\n").expect("write");
        fs::write(root.join("node_modules/pkg/index.js"), "x\n").expect("write");
        fs::write(root.join("secret.txt"), "x\n").expect("write");

        let discovery = discover(root, &options()).expect("discovery");
        let paths: Vec<_> = discovery
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        // `.gitignore` is itself a hidden file, so it is not in the scan set.
        assert_eq!(paths, vec!["src/index.ts"]);
    }

    #[test]
    fn explicit_exclude_wins_over_include() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::create_dir_all(root.join("src")).expect("mkdir");
        fs::write(root.join("src/a.ts"), "a\n").expect("write");
        fs::write(root.join("src/a.test.ts"), "b\n").expect("write");

        let mut opts = options();
        opts.exclude = vec!["**/*.test.ts".to_string()];
        let discovery = discover(root, &opts).expect("discovery");
        let paths: Vec<_> = discovery
            .files
            .iter()
            .map(|file| file.relative_path.as_str())
            .collect();
        assert_eq!(paths, vec!["src/a.ts"]);
    }

    #[test]
    fn hidden_files_are_skipped_unless_requested() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        fs::write(root.join(".hidden.ts"), "a\n").expect("write");
        fs::write(root.join("visible.ts"), "b\n").expect("write");

        let default_paths = discover(root, &options()).expect("discovery");
        assert_eq!(default_paths.files.len(), 1);

        let mut opts = options();
        opts.include_hidden = true;
        let with_hidden = discover(root, &opts).expect("discovery");
        assert_eq!(with_hidden.files.len(), 2);
    }

    #[test]
    fn truncates_at_max_files_and_reports_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path();
        for index in 0..5 {
            fs::write(root.join(format!("f{index}.ts")), "x\n").expect("write");
        }
        let mut opts = options();
        opts.max_files = 2;
        let discovery = discover(root, &opts).expect("discovery");
        assert_eq!(discovery.files.len(), 2);
        assert!(discovery.truncated);
    }

    #[test]
    fn rejects_a_missing_root() {
        let error = discover(Path::new("./definitely-not-here-42"), &options()).expect_err("error");
        assert!(matches!(error, DiscoveryError::RootMissing(_)));
    }

    #[test]
    fn rejects_a_file_as_root() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("a.ts");
        fs::write(&file, "x\n").expect("write");
        let error = discover(&file, &options()).expect_err("error");
        assert!(matches!(error, DiscoveryError::RootNotDirectory(_)));
    }

    #[test]
    fn reports_invalid_exclude_globs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut opts = options();
        opts.exclude = vec!["[".to_string()];
        let error = discover(dir.path(), &opts).expect_err("error");
        assert!(matches!(error, DiscoveryError::InvalidExclude { .. }));
    }
}
