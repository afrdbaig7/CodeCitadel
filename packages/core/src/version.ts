/**
 * CodeCitadel core version.
 *
 * Kept as a literal so the package can build without importing JSON across the
 * `rootDir` boundary. `src/version.test.ts` fails if it drifts from
 * `package.json`, so the duplication cannot go unnoticed.
 */
export const CODECITADEL_VERSION = "0.1.0";
