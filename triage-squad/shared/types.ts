// CONTRACT (owned by the planner). Wire types shared by the Node API and the React client.
// Do not change these shapes without updating SPEC.md. All times are epoch milliseconds.

export const SEVERITIES = ['info', 'warning', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const STATUSES = ['open', 'acked', 'resolved'] as const;
export type Status = (typeof STATUSES)[number];

export const ROLES = ['viewer', 'responder', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export interface UserDTO {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

export interface IncidentDTO {
  id: number;
  fingerprint: string;
  source: string;
  title: string;
  severity: Severity;
  status: Status;
  assigneeId: string | null;
  /**
   * Concurrency token for If-Match. Bumped ONLY by changes a human acts on:
   * status changes (ack, resolve, reopen including flap reopen) and assignment.
   * NOT bumped by alert folds, severity escalation, or SLA breach, so machine
   * noise never invalidates a responder's pending write.
   */
  version: number;
  /** Bumped on EVERY write (including folds and SLA). Clients merge live data by rev. */
  rev: number;
  alertCount: number;
  firstSeen: number;
  lastSeen: number;
  ackedAt: number | null;
  ackedBy: string | null;
  resolvedAt: number | null;
  resolvedBy: string | null;
  /** SLA deadline while a critical incident is open (unacked) and not yet breached. */
  slaDueAt: number | null;
  slaBreachedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface AlertDTO {
  id: number;
  incidentId: number;
  source: string;
  fingerprint: string;
  severity: Severity;
  title: string;
  payload: unknown;
  /** Event time claimed by the source. Used for grouping. */
  ts: number;
  /** Server receipt time. */
  receivedAt: number;
}

export interface AuditDTO {
  id: number;
  incidentId: number | null;
  actor: string;
  actorName: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: number;
}

export interface ListResponse {
  items: IncidentDTO[];
  nextCursor: string | null;
  /** Total matching rows. Only on the first page (no cursor); null otherwise. */
  total: number | null;
  serverTime: number;
}

export interface DetailResponse {
  incident: IncidentDTO;
  alerts: AlertDTO[];
  audit: AuditDTO[];
  serverTime: number;
}

export interface ErrorBody {
  error: { code: string; message: string };
  /** Present on 409 responses: the record as the server holds it now. */
  current?: IncidentDTO;
}

export interface IncidentEventData {
  incident: IncidentDTO;
  audit: AuditDTO[];
}

export interface BulkAckItem {
  id: number;
  version: number;
}

export interface BulkAckResult {
  id: number;
  ok: boolean;
  status: number;
  incident?: IncidentDTO;
  error?: { code: string; message: string };
  current?: IncidentDTO;
}

export interface IngestResponse {
  action: 'created' | 'folded' | 'reopened' | 'attached' | 'duplicate';
  incidentId: number;
  incident: IncidentDTO;
}

export type StreamEventType =
  | 'hello'
  | 'ping'
  | 'resync'
  | 'incident.created'
  | 'incident.updated'
  | 'incident.sla_breached';
