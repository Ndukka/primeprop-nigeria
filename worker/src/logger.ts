// PP-SEC-044: Structured logging with request IDs and security event tracking.
// Never log secrets, tokens, passwords, cookies, or reset links.

export function generateRequestId(): string {
  return crypto.randomUUID();
}

export interface LogEntry {
  requestId: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'security';
  route?: string;
  method?: string;
  status?: number;
  durationMs?: number;
  actorId?: number;
  actorEmail?: string;
  action?: string;
  message: string;
  ip?: string;
  // Never include: password, token, cookie, secret, reset_token
}

export function log(entry: LogEntry): void {
  // In production, send to Cloudflare Analytics Engine or a log sink.
  // For now, structured console output (Cloudflare captures console.log).
  const { requestId, timestamp, level, ...rest } = entry;
  const safeEntry = { requestId, timestamp: timestamp || new Date().toISOString(), level, ...rest };
  
  if (level === 'error') {
    console.error(JSON.stringify(safeEntry));
  } else if (level === 'warn') {
    console.warn(JSON.stringify(safeEntry));
  } else {
    console.log(JSON.stringify(safeEntry));
  }
}

// Security event logger — use for auth, moderation, and sensitive actions
export function logSecurity(
  requestId: string,
  action: string,
  actorId?: number,
  actorEmail?: string,
  targetType?: string,
  targetId?: number,
  details?: Record<string, unknown>,
  ip?: string
): void {
  log({
    requestId,
    timestamp: new Date().toISOString(),
    level: 'security',
    action,
    actorId,
    actorEmail,
    route: `${targetType || ''}/${targetId || ''}`,
    message: action,
    ip,
    // Cast details to avoid type issues — only safe values should be passed
    ...(details ? { detail: JSON.stringify(details) } : {}),
  } as LogEntry);
}

// Request-scoped logger factory
export function createRequestLogger(request: Request, requestId?: string) {
  const rid = requestId || generateRequestId();
  const url = new URL(request.url);
  const ip = request.headers.get('CF-Connecting-IP') || '';

  return {
    requestId: rid,
    ip,
    info(message: string, extra?: Record<string, unknown>) {
      log({
        requestId: rid,
        timestamp: new Date().toISOString(),
        level: 'info',
        route: url.pathname,
        method: request.method,
        message,
        ip,
        ...extra,
      } as LogEntry);
    },
    warn(message: string, extra?: Record<string, unknown>) {
      log({
        requestId: rid,
        timestamp: new Date().toISOString(),
        level: 'warn',
        route: url.pathname,
        method: request.method,
        message,
        ip,
        ...extra,
      } as LogEntry);
    },
    error(message: string, extra?: Record<string, unknown>) {
      log({
        requestId: rid,
        timestamp: new Date().toISOString(),
        level: 'error',
        route: url.pathname,
        method: request.method,
        message,
        ip,
        ...extra,
      } as LogEntry);
    },
    security(action: string, actorId?: number, actorEmail?: string, details?: Record<string, unknown>) {
      logSecurity(rid, action, actorId, actorEmail, url.pathname, undefined, details, ip);
    },
  };
}
