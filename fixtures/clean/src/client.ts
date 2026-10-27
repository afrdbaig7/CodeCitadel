// Secrets come from the environment; no credential material is in the file.
const endpoint = process.env.SERVICE_ENDPOINT ?? "https://example.test";

export async function fetchStatus(): Promise<{ ok: boolean }> {
  const response = await fetch(`${endpoint}/status`);
  return { ok: response.ok };
}
