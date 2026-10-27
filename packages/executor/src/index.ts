export {
  createSourceCopy,
  DEFAULT_COPY_LIMITS,
  SourceCopyLimitError,
  type SourceCopy,
  type SourceCopyLimits,
} from "./copy.js";
export {
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  ENVIRONMENT_NAME_PATTERN,
  EnvironmentError,
  MAX_PASSTHROUGH_ENV,
  buildEnvironment,
  runSupervised,
  type ProcessOutcome,
  type ProcessStatus,
  type ResolvedEnvironment,
} from "./process.js";
export {
  aggregateStatus,
  isolationFor,
  summarize,
} from "./record.js";
export {
  executeTests,
  resolveVitestRunner,
  RunnerNotFoundError,
  type ExecuteTestsInput,
  type ExecuteTestsResult,
  type ResolvedVitest,
} from "./vitest.js";
export {
  applyPatch,
  MAX_PATCH_BYTES,
  MAX_PATCH_FILES,
  parseUnifiedDiff,
  PatchApplyError,
  PatchParseError,
  validatePatchPath,
  type AppliedPatch,
  type AppliedPatchFile,
  type ParsedPatch,
  type PatchFile,
  type PatchHunk,
  type PatchLine,
} from "./patch.js";
export {
  boundMessage,
  normalizeResultPath,
  normalizeVitestReport,
  stableTestId,
  vitestJsonReportSchema,
  type NormalizeInput,
  type NormalizedResults,
} from "./vitest-report.js";
