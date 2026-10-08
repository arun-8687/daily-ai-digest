// User-facing copy for failed actions.
import type { UserDTO } from '../../shared/types';
import { ApiError, messageOf } from './api';
import { describeCurrent } from './format';

export const READ_ONLY = 'Your role can view incidents but not change them.';

/** Turns a failed action into one sentence. A 409 names the current state. The store has already rolled back. */
export function describeFailure(err: unknown, action: string, users: readonly UserDTO[]): string {
  const prefix = `Couldn't ${action}`;
  if (!(err instanceof ApiError)) return `${prefix}: ${messageOf(err)}`;

  if (err.status === 0) {
    return `${prefix}: network error. Your change was rolled back.`;
  }
  if (err.code === 'version_conflict') {
    if (err.current) {
      return `${prefix}: it changed while you were looking at it (${describeCurrent(err.current, users)}). Your change was rolled back.`;
    }
    return `${prefix}: it changed while you were looking at it. Your change was rolled back.`;
  }
  if (err.code === 'illegal_transition') {
    if (err.current) {
      return `${prefix}: it is no longer in a state that allows this (${describeCurrent(err.current, users)}). Your change was rolled back.`;
    }
    return `${prefix}: it is no longer in a state that allows this. Your change was rolled back.`;
  }
  if (err.status === 401) return 'Your session has ended. Sign in again.';
  if (err.status === 403) return `${prefix}: your role does not allow this.`;
  if (err.status === 428) return `${prefix}: the request was missing a version. Refresh and try again.`;
  return `${prefix}: ${err.message}`;
}
