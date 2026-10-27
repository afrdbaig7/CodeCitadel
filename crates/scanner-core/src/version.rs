/// Version of the scanner binary, taken from Cargo at build time so the
/// capability handshake and the release artifact can never disagree.
pub const SCANNER_VERSION: &str = env!("CARGO_PKG_VERSION");
