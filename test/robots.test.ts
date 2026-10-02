import { describe, expect, it } from 'vitest';
import { ALLOW_ALL, isAllowed, parseRobots, policyForResponse } from '../src/robots.ts';

const url = (path: string) => new URL('https://shop.example' + path);

describe('robots.txt', () => {
  it('uses the * group, longest match wins, and Allow wins ties', () => {
    const policy = parseRobots(`
      User-agent: *
      Disallow: /private
      Allow: /private/ok
      Disallow: /*.pdf$
      Disallow: /search?   # query pages
    `);
    expect(isAllowed(policy, url('/sell/digi/s/ex13'))).toBe(true);
    expect(isAllowed(policy, url('/private/x'))).toBe(false);
    expect(isAllowed(policy, url('/private/ok/page'))).toBe(true);
    expect(isAllowed(policy, url('/files/a.pdf'))).toBe(false);
    expect(isAllowed(policy, url('/files/a.pdf?x=1'))).toBe(true);
    expect(isAllowed(policy, url('/search?q=1'))).toBe(false);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a'), url('/a'))).toBe(true);
  });
  it('prefers a group naming VoracityWatcher and ignores groups for other bots', () => {
    const text = 'User-agent: bingbot\nDisallow: /\nCrawl-delay: 10\n\nUser-agent: *\nDisallow: /cart\n\nUser-agent: VoracityWatcher\nUser-agent: other\nDisallow: /sell\nCrawl-delay: 7';
    const policy = parseRobots(text);
    expect(isAllowed(policy, url('/sell/x'))).toBe(false);
    expect(isAllowed(policy, url('/cart'))).toBe(true);
    expect(policy.crawlDelay).toBe(7);
    const generic = parseRobots(text, 'SomeoneElse');
    expect(isAllowed(generic, url('/cart'))).toBe(false);
    expect(generic.crawlDelay).toBeUndefined();
  });
  it("reads yuyu-tei's real-world shape: crawl delays only for named bots", () => {
    const policy = parseRobots('User-agent: Slurp \nCrawl-delay: 1\n\nUser-Agent: serpstatbot\nCrawl-Delay: 20\n\nSitemap:https://example/index.xml');
    expect(policy).toEqual({ rules: [], crawlDelay: undefined });
    expect(isAllowed(policy, url('/sell/digi/s/ex13'))).toBe(true);
  });
  it('treats an empty Disallow as allow-all and Disallow: / as block-all', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow:'), url('/x'))).toBe(true);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), url('/x'))).toBe(false);
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /'), url('/robots.txt'))).toBe(true);
  });
  it('maps fetch outcomes per RFC 9309: 4xx allows all, 5xx and network errors disallow all', () => {
    expect(policyForResponse(404, '')).toBe(ALLOW_ALL);
    expect(policyForResponse(403, '')).toBe(ALLOW_ALL);
    expect(policyForResponse(503, '').unavailable).toBe(true);
    expect(policyForResponse(null, '').unavailable).toBe(true);
    expect(isAllowed(policyForResponse(500, ''), url('/x'))).toBe(false);
  });
});
