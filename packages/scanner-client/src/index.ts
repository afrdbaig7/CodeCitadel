export { runScan, readCapabilities, type RunScanOptions } from "./client.js";
export {
  ScanAbortedError,
  ScannerProtocolError,
  ScannerRunError,
  ScannerTimeoutError,
} from "./errors.js";
export { ScanStreamCollector, MAX_RECORD_BYTES, type ScanStreamResult } from "./stream.js";
export {
  resolveScannerBinary,
  platformPackageName,
  ScannerBinaryNotFoundError,
  ScannerBinaryIntegrityError,
  type BinarySource,
  type ResolvedScanner,
  type ResolveScannerOptions,
} from "./resolve-binary.js";
