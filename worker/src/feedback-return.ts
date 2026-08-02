const SAFE_RETURN_PATHS = new Set([
  '/agent-profile',
  '/listing-detail',
  '/listing-detail-1',
  '/listing-detail-2',
  '/listing-detail-3',
  '/properties',
]);

const SAFE_ACTIONS = new Set([
  'rate-agent',
  'report-agent',
  'report-listing',
]);

function actionAllowedForPath(pathname: string, action: string): boolean {
  if (!SAFE_ACTIONS.has(action)) return false;
  if (pathname === '/agent-profile') {
    return action === 'rate-agent' || action === 'report-agent';
  }
  if (pathname.startsWith('/listing-detail')) return true;
  return false;
}

export function safeFeedbackReturn(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return '/properties';
  }

  try {
    const parsed = new URL(value, 'https://primeprop.invalid');
    if (!SAFE_RETURN_PATHS.has(parsed.pathname)) return '/properties';

    const allowedKeys = parsed.pathname === '/agent-profile'
      ? new Set(['id', 'listing', 'feedbackAction'])
      : parsed.pathname.startsWith('/listing-detail')
        ? new Set(['id', 'feedbackAction'])
        : new Set<string>();

    for (const key of parsed.searchParams.keys()) {
      if (!allowedKeys.has(key)) return '/properties';
    }

    for (const key of ['id', 'listing']) {
      if (!parsed.searchParams.has(key)) continue;
      const parameter = parsed.searchParams.get(key) || '';
      if (!/^\d+$/.test(parameter) || Number(parameter) <= 0) return '/properties';
    }

    if (parsed.pathname === '/agent-profile'
      && !parsed.searchParams.has('id')
      && !parsed.searchParams.has('listing')) {
      return '/properties';
    }

    const action = parsed.searchParams.get('feedbackAction') || '';
    if (action && !actionAllowedForPath(parsed.pathname, action)) return '/properties';

    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/properties';
  }
}

export function feedbackReturnWithStatus(returnTo: string, status: string): string {
  const safe = safeFeedbackReturn(returnTo);
  const parsed = new URL(safe, 'https://primeprop.invalid');
  parsed.searchParams.set('feedbackAuth', status);
  return `${parsed.pathname}${parsed.search}`;
}
