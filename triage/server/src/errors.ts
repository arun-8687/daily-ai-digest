import type { IncidentDTO } from '../../shared/types';

/** An error that maps directly onto an HTTP response. `current` carries the server's copy on 409s. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly current?: IncidentDTO,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
