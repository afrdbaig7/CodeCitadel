export {
  scanRepository,
  scanRepositoryDetailed,
  getScannerCapabilities,
  type ScanRepositoryInput,
  type ScanRepositoryResult,
} from "./engine.js";
export {
  buildReport,
  countByCategory,
  countBySeverity,
  describeLimitations,
  findingsAtOrAbove,
  sortFindings,
  type ReportInput,
} from "./report.js";
export { buildSnapshot, diffSnapshots, introducedAtOrAbove } from "./snapshot.js";
export { compareExecutionReports, type CompareExecutionInput } from "./compare-execution.js";
export {
  acceptRequirement,
  acceptanceStatusOf,
  evaluateRequirements,
  parseRequirementDocument,
  RequirementDocumentError,
  summarizeRequirements,
  type AcceptRequirementInput,
  type EvaluateRequirementsInput,
} from "./requirements.js";
export {
  classifyPatchPath,
  decidePatchVerdict,
  inspectPatch,
  type InspectablePatchFile,
  type InspectablePatchLine,
  type PatchVerdict,
  type PatchVerdictInput,
} from "./patch-verification.js";
export {
  decideReproductionVerdict,
  findReproduction,
  parseReproductionDocument,
  ReproductionError,
  validateReproductionPath,
  type ReproductionDecision,
  type ReproductionDecisionInput,
} from "./reproduction.js";
export {
  BundleValidationError,
  createBundleFromPatchVerification,
  createBundleFromReproduction,
  createBundleFromRun,
  decideReplayVerdict,
  validateEvidenceBundle,
  type ReplayRecheckInput,
} from "./evidence.js";
export { CODECITADEL_VERSION } from "./version.js";
