// robots.txt handling following RFC 9309, plus the widely used Crawl-delay
// extension. The watcher identifies itself as PRODUCT_TOKEN; a group naming
// that token takes precedence over the "*" group.

export const PRODUCT_TOKEN = 'VoracityWatcher';

interface Rule { allow: boolean; pattern: string }
export interface RobotsPolicy {
  rules: Rule[];
  /** Seconds between requests requested by the site, if any. */
  crawlDelay?: number;
  /** True when every path is disallowed because robots.txt could not be read safely. */
  unavailable?: boolean;
}

export const ALLOW_ALL: RobotsPolicy = { rules: [] };
export const DISALLOW_ALL: RobotsPolicy = { rules: [{ allow: false, pattern: '/' }], unavailable: true };

interface Group { agents: string[]; rules: Rule[]; crawlDelay?: number }

export function parseRobots(text: string, token = PRODUCT_TOKEN): RobotsPolicy {
  const groups: Group[] = [];
  let current: Group | null = null, lastWasAgent = false;
  for (const raw of text.slice(0, 512_000).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase(), value = match[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === 'allow' || key === 'disallow') {
      // An empty Disallow means "allow everything" and adds no rule.
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else if (key === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
    }
  }
  const name = token.toLowerCase();
  const specific = groups.filter(group => group.agents.includes(name));
  const chosen = specific.length ? specific : groups.filter(group => group.agents.includes('*'));
  const delays = chosen.map(group => group.crawlDelay).filter((value): value is number => value !== undefined);
  return { rules: chosen.flatMap(group => group.rules), crawlDelay: delays.length ? Math.max(...delays) : undefined };
}

function patternMatches(pattern: string, path: string) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const expression = body.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp('^' + expression + (anchored ? '$' : '')).test(path);
}

const decodeSafe = (value: string) => { try { return decodeURIComponent(value); } catch { return value; } };

/** Longest matching rule wins; on a tie, Allow wins (RFC 9309 §2.2.2). */
export function isAllowed(policy: RobotsPolicy, url: URL) {
  const path = decodeSafe(url.pathname + url.search);
  if (path === '/robots.txt') return true;
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!patternMatches(decodeSafe(rule.pattern), path)) continue;
    if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
  }
  return best ? best.allow : true;
}

/**
 * RFC 9309 §2.3.1: 2xx is parsed; 4xx means no restrictions; 5xx or a network
 * failure means the crawler must assume everything is disallowed for now.
 */
export function policyForResponse(status: number | null, body: string): RobotsPolicy {
  if (status !== null && status >= 200 && status < 300) return parseRobots(body);
  if (status !== null && status >= 400 && status < 500) return ALLOW_ALL;
  return DISALLOW_ALL;
}
