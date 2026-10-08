import type { IncidentDTO } from '../../shared/types';

/** An error that maps directly onto an HTTP response: `{error:{code,message}, current?}`. */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  /** Present on 409 responses: the incident as the server holds it now. */
  readonly current?: IncidentDTO;

  constructor(status: number, code: string, message: string, current?: IncidentDTO) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.current = current;
  }
}
