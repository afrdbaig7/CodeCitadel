//! Bounded file reading, content digests, and binary detection.
//!
//! Digest schema version 1: `sha256:<lowercase hex>` over the exact bytes read
//! from disk. The digest identifies content, not a path, so a moved file keeps
//! its identity and a rewritten file never reuses cached evidence.

use std::fs::File;
use std::io::{self, Read};
use std::path::Path;

use sha2::{Digest, Sha256};

pub const DIGEST_SCHEMA_VERSION: u32 = 1;
const BINARY_PROBE_BYTES: usize = 8 * 1024;

#[derive(Debug)]
pub struct FileBytes {
    pub bytes: Vec<u8>,
    pub digest: String,
    pub binary: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    #[error("file exceeds the {limit} byte limit")]
    TooLarge { limit: u64 },
    #[error("cannot read file: {0}")]
    Io(#[from] io::Error),
}

/// Reads at most `max_bytes`. A larger file is rejected rather than silently
/// truncated: analysing half a file and reporting it as scanned would be a lie.
pub fn read_bounded(path: &Path, max_bytes: u64) -> Result<FileBytes, ReadError> {
    let file = File::open(path)?;
    // Read one byte past the limit so an exactly-at-limit file still passes.
    let mut reader = file.take(max_bytes.saturating_add(1));
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes)?;

    if bytes.len() as u64 > max_bytes {
        return Err(ReadError::TooLarge { limit: max_bytes });
    }

    let digest = format!("sha256:{}", hex_sha256(&bytes));
    let binary = looks_binary(&bytes);
    Ok(FileBytes {
        bytes,
        digest,
        binary,
    })
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// A NUL byte in the first 8 KiB means text tooling cannot reason about this
/// file. UTF-16 sources also contain NULs, so they are "binary" here on
/// purpose; treating them as text would need decoding we do not implement yet.
pub fn looks_binary(bytes: &[u8]) -> bool {
    let probe = &bytes[..bytes.len().min(BINARY_PROBE_BYTES)];
    probe.contains(&0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(dir: &tempfile::TempDir, name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = dir.path().join(name);
        let mut file = File::create(&path).expect("create");
        file.write_all(bytes).expect("write");
        path
    }

    #[test]
    fn digest_matches_known_sha256() {
        // sha256("abc")
        assert_eq!(
            hex_sha256(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn digest_is_stable_for_identical_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let first = write_temp(&dir, "a.txt", b"same");
        let second = write_temp(&dir, "b.txt", b"same");
        let a = read_bounded(&first, 1024).expect("read");
        let b = read_bounded(&second, 1024).expect("read");
        assert_eq!(a.digest, b.digest);
        assert!(a.digest.starts_with("sha256:"));
    }

    #[test]
    fn rejects_files_over_the_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_temp(&dir, "big.txt", b"0123456789");
        let error = read_bounded(&path, 5).expect_err("must be rejected");
        assert!(matches!(error, ReadError::TooLarge { .. }));
    }

    #[test]
    fn accepts_a_file_exactly_at_the_limit() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = write_temp(&dir, "exact.txt", b"01234");
        assert!(read_bounded(&path, 5).is_ok());
    }

    #[test]
    fn detects_binary_and_utf16_content() {
        assert!(looks_binary(b"\x00\x01binary"));
        // UTF-16LE "hi" begins with a NUL-free letter but contains NUL bytes.
        assert!(looks_binary(b"h\x00i\x00"));
        assert!(!looks_binary(b"plain text\n"));
    }
}
