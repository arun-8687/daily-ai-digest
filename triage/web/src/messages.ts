import { ApiError, messageOf } from './api';
import { describeCurrent } from './format';
import type { UserDTO } from '../../shared/types';

export const READ_ONLY = 'Your role can view incidents but not change them.';

/** Turns a failed action into a sentence that says what happened and what the server holds now. */
export function describeFailure(err: unknown, action: string, users: readonly UserDTO[]): string {
  if (err instanceof ApiError) {
    if (err.status === 403) return `Couldn't ${action}: ${READ_ONLY.toLowerCase()}`;
    if (err.current && err.code === 'version_conflict') {
      return `Couldn't ${action}: it changed while you were looking at it (${describeCurrent(err.current, users)}). Your change was rolled back.`;
    }
    if (err.current && err.code === 'illegal_transition') {
      return `Couldn't ${action}: ${err.message} Your change was rolled back.`;
    }
    if (err.code === 'not_loaded') return `Couldn't ${action}: that incident is not loaded.`;
  }
  return `Couldn't ${action}: ${messageOf(err)}`;
}
