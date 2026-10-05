// Small HTTP helpers shared by the API routes.

/** An error with an HTTP status; thrown by feature modules, mapped by routes. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Best-effort message extraction for unexpected errors. */
export function errorMessage(error, fallback) {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
