import { ApiError, isAbortError, messageOf } from './api';
import { describeCurrent } from './format';
import type { UserDTO } from '../../shared/types';

export const READ_ONLY = 'Your role can view incidents but not change them.';

/**
 * Turns a failed write into one sentence for a toast. `action` is the phrase that
 * completes "Couldn't ...", for example "acknowledge INC-12".
 */
export function describeFailure(err: unknown, action: string, users: readonly UserDTO[]): string {
  const prefix = `Couldn't ${action}`;
  if (err instanceof ApiError) {
    if (err.code === 'version_conflict') {
      return err.current
        ? `${prefix}: it changed while you were looking at it (${describeCurrent(err.current, users)}). Your change was rolled back.`
        : `${prefix}: it changed while you were looking at it. Your change was rolled back.`;
    }
    if (err.code === 'illegal_transition') {
      return err.current
        ? `${prefix}: that is not allowed now (${describeCurrent(err.current, users)}). Your change was rolled back.`
        : `${prefix}: that is not allowed from the current state.`;
    }
    if (err.code === 'network' || err.status === 0) {
      return `${prefix}: you appear to be offline. Check your connection and try again.`;
    }
    if (err.code === 'cross_origin') {
      return `${prefix}: the request was blocked for security reasons. Reload the page and try again.`;
    }
    if (err.code === 'precondition_required' || err.code === 'bad_if_match') {
      return `${prefix}: the page was out of date. Reload and try again.`;
    }
    if (err.code === 'unknown_assignee') return `${prefix}: that assignee does not exist.`;
    if (err.code === 'last_admin') return `${prefix}: the last admin cannot be demoted.`;
    if (err.status === 401 || err.code === 'unauthenticated') {
      return `${prefix}: your session has ended. Sign in again to continue.`;
    }
    if (err.status === 403 || err.code === 'forbidden') return `${prefix}: your role does not allow this.`;
    if (err.status === 404) return `${prefix}: this incident could not be found.`;
    if (err.status === 429) return `${prefix}: too many requests. Wait a moment and try again.`;
    if (err.status >= 500) return `${prefix}: the server ran into a problem. Try again.`;
    return `${prefix}: ${err.message}`;
  }
  if (isAbortError(err)) return `${prefix}: the request was cancelled.`;
  return `${prefix}: ${messageOf(err)}`;
}
