/** The message off an unknown error, without assuming it is an `Error`. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first line of {@link errorMessage}, for single-line log and refusal text. */
export function errorLine(error: unknown): string {
  return errorMessage(error).split('\n')[0] ?? '';
}
