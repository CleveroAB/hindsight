// ============================================================================
// The tunnel gate (proxy.ts) — the single thing standing between a share link
// and the whole app + API being reachable from the internet (PROTOCOL.md §6,
// SECURITY.md). Two properties matter and both are tested here:
//
//   1. Local and LAN traffic is never touched.
//   2. Tunnel traffic reaches /share/<token> and NOTHING else.
// ============================================================================

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { proxy } from '@/proxy';

/** Silence (and capture) the [share] audit lines the gate writes per request. */
let logged: string[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logged = [];
  logSpy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.join(' '));
  });
});

afterEach(() => {
  logSpy.mockRestore();
});

function request(pathname: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`, { headers });
}

/** 200 here means "passed through to the app" (NextResponse.next()). */
function status(pathname: string, headers?: Record<string, string>): number {
  return proxy(request(pathname, headers)).status;
}

const PUBLIC = { 'x-forwarded-for': '203.0.113.9' };

describe('local traffic is untouched', () => {
  test('a request with no forwarding headers passes through', () => {
    expect(status('/')).toBe(200);
    expect(status('/api/sessions')).toBe(200);
    expect(logged).toHaveLength(0);
  });

  test('Next’s own dev-server X-Forwarded-For does not look like a tunnel', () => {
    // The regression this whole address-based design exists to prevent: `next
    // dev` stamps `X-Forwarded-For: ::1` on ordinary local requests, so
    // "header is present" would 404 the entire app for the developer.
    expect(status('/', { 'x-forwarded-for': '::1' })).toBe(200);
    expect(status('/api/sessions', { 'x-forwarded-for': '::1' })).toBe(200);
    expect(logged).toHaveLength(0);
  });

  test.each([
    ['127.0.0.1'],
    ['::1'],
    ['::ffff:127.0.0.1'],
    ['10.0.0.4'],
    ['172.16.0.1'],
    ['172.31.255.255'],
    ['192.168.1.20'],
    ['169.254.10.1'],
    ['fd00::1'],
    ['fc00::1'],
    ['fe80::1'],
  ])('LAN/loopback address %p keeps full access', (ip) => {
    expect(status('/api/sessions', { 'x-forwarded-for': ip })).toBe(200);
  });
});

describe('tunnel traffic is confined to the share page', () => {
  test('a share URL is allowed', () => {
    expect(status('/share/V1StGXR8Z5jdHi6BmyT', PUBLIC)).toBe(200);
  });

  test('a trailing slash is still the share page', () => {
    expect(status('/share/abc123/', PUBLIC)).toBe(200);
  });

  test.each([
    ['/'],
    ['/api/sessions'],
    ['/api/health'],
    ['/api/settings'],
    ['/api/sessions/abc/stream'],
    ['/strategy/abc'],
    ['/_next/static/chunks/main.js'],
    ['/icon.svg'],
    ['/share'],
    ['/share/'],
    ['/share/abc/extra'],
    ['/share/abc/../../api/sessions'],
  ])('%p is 404 for a tunnel visitor', (pathname) => {
    expect(status(pathname, PUBLIC)).toBe(404);
  });

  test('a token outside the nanoid alphabet is not a share page', () => {
    expect(status('/share/abc$def', PUBLIC)).toBe(404);
    expect(status('/share/abc def', PUBLIC)).toBe(404);
    expect(status(`/share/${'a'.repeat(65)}`, PUBLIC)).toBe(404);
  });

  test('a 64-character token is still accepted', () => {
    expect(status(`/share/${'a'.repeat(64)}`, PUBLIC)).toBe(200);
  });

  test('non-GET methods get no special treatment', () => {
    const res = proxy(
      new NextRequest('http://localhost:3000/api/sessions', { method: 'POST', headers: PUBLIC }),
    );
    expect(res.status).toBe(404);
  });
});

describe('detecting a tunnel', () => {
  test('a public IP anywhere in the chain counts, even behind spoofed entries', () => {
    // A remote visitor can PREPEND junk to X-Forwarded-For but cannot remove the
    // real address the daemon appends — so a private-looking first hop must not
    // buy access to the app.
    const spoofed = { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' };
    expect(status('/api/sessions', spoofed)).toBe(404);
    expect(status('/share/abc', spoofed)).toBe(200);
  });

  test('a public IP last in a long chain still counts', () => {
    const chain = { 'x-forwarded-for': '10.0.0.1, 192.168.1.1, ::1, 198.51.100.7' };
    expect(status('/api/sessions', chain)).toBe(404);
  });

  test.each([['cf-connecting-ip'], ['x-real-ip']])(
    'the %p header is inspected too',
    (header) => {
      expect(status('/api/sessions', { [header]: '203.0.113.9' })).toBe(404);
    },
  );

  test('Cf-Ray alone is enough — no local browser sends it', () => {
    expect(status('/api/sessions', { 'cf-ray': '7d3f8a1b2c3d4e5f-ARN' })).toBe(404);
    expect(status('/share/abc', { 'cf-ray': '7d3f8a1b2c3d4e5f-ARN' })).toBe(200);
  });

  test('addresses just outside RFC1918 are public', () => {
    // 172.16/12 covers 172.16-172.31 only; the neighbours must not be trusted.
    expect(status('/api/sessions', { 'x-forwarded-for': '172.15.0.1' })).toBe(404);
    expect(status('/api/sessions', { 'x-forwarded-for': '172.32.0.1' })).toBe(404);
  });

  test('unparseable addresses fail closed, not open', () => {
    expect(status('/api/sessions', { 'x-forwarded-for': 'garbage' })).toBe(404);
  });
});

describe('audit log', () => {
  test('an allowed tunnel request is logged with the visitor IP', () => {
    status('/share/abc', PUBLIC);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('allow');
    expect(logged[0]).toContain('/share/abc');
    expect(logged[0]).toContain('203.0.113.9');
  });

  test('a denied probe is logged too', () => {
    status('/api/sessions', PUBLIC);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('DENY');
    expect(logged[0]).toContain('203.0.113.9');
  });

  test('the logged IP is the public one, not a spoofed private prefix', () => {
    status('/share/abc', { 'x-forwarded-for': '127.0.0.1, 198.51.100.7' });
    expect(logged[0]).toContain('198.51.100.7');
  });
});
