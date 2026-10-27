/** The scanner emitted something that does not match the protocol contract. */
export class ScannerProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerProtocolError";
  }
}

/** The scanner reported a fatal condition, or exited non-zero. */
export class ScannerRunError extends Error {
  readonly code: string;
  readonly stderr: string;

  constructor(code: string, message: string, stderr: string) {
    super(message);
    this.name = "ScannerRunError";
    this.code = code;
    this.stderr = stderr;
  }
}

export class ScannerTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`The scanner did not finish within ${timeoutMs}ms and was terminated.`);
    this.name = "ScannerTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ScanAbortedError extends Error {
  constructor() {
    super("The scan was cancelled.");
    this.name = "ScanAbortedError";
  }
}
