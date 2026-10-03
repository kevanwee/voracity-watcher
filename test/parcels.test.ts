import { describe, expect, it } from 'vitest';
import { briefingParcels, NOT_CONFIGURED, parcelFor, parcelsReply, POLL_MS, RETRY_REGISTER_MS, runParcels, type Parcel, type ParcelState, type ParcelStore } from '../src/parcels.ts';
import { toInfo, track17 } from '../src/track17.ts';

const UID = 'owner', CHAT = '42';
const parcel = (over: Partial<Parcel> = {}): Parcel => ({ id: 'p1', number: 'SPXSG012345678901', label: 'Keyboard', carrier: 0, archived: false, createdAt: 1, updatedAt: 1, revision: 0, ...over });
const info = (number: string, status: string, text: string, time = '2026-10-03T10:00:00+08:00', extra: Record<string, unknown> = {}) => ({
  number, carrier: 190271, track_info: {
    latest_status: { status }, latest_event: { time_iso: time, description: text, location: 'Singapore' },
    tracking: { providers: [{ provider: { key: 190271, name: 'Shopee Express' }, events: [{ time_iso: time, description: text, location: 'Singapore' }, { time_iso: '2026-10-02T09:00:00+08:00', description: 'Picked up', location: 'Shenzhen' }] }] },
    ...extra,
  },
});

/** Fake 17TRACK plus an in-memory store, with a clock the test moves. */
function setup(parcels: Parcel[], { configured = true } = {}) {
  const states = new Map<string, ParcelState>();
  const sent: string[] = [], calls: { path: string; body: { number: string; carrier?: number }[] }[] = [];
  let clock = 1_800_000_000_000, register: (n: string) => 'ok' | 'already' | string = () => 'ok';
  let track: Record<string, ReturnType<typeof info>> = {};
  const fetcher = (async (url: string, init?: RequestInit) => {
    const path = url.replace('https://api.17track.net/track/v2.2', ''), body = JSON.parse(String(init?.body));
    expect((init?.headers as Record<string, string>)['17token']).toBe('KEY');
    calls.push({ path, body });
    if (path === '/register') {
      const accepted: unknown[] = [], rejected: unknown[] = [];
      for (const item of body) {
        const outcome = register(item.number);
        if (outcome === 'ok') accepted.push({ number: item.number, carrier: 190271 });
        else rejected.push({ number: item.number, error: { code: outcome === 'already' ? -18019901 : -1, message: outcome === 'already' ? 'already registered' : outcome } });
      }
      return new Response(JSON.stringify({ code: 0, data: { accepted, rejected } }));
    }
    return new Response(JSON.stringify({ code: 0, data: { accepted: body.map((item: { number: string }) => track[item.number]).filter(Boolean), rejected: [] } }));
  }) as typeof fetch;
  const store: ParcelStore = {
    parcels: async () => parcels, parcelStates: async () => new Map(states),
    saveParcelState: async (_uid, id, state) => { expect(JSON.stringify(state)).not.toContain('undefined'); states.set(id, state); },
    createParcel: async () => {},
  };
  const run = () => runParcels({ owners: { [UID]: CHAT }, store, send: async (_chat, text) => { sent.push(text); }, track: configured ? track17('KEY', fetcher) : null, now: () => clock });
  return {
    states, sent, calls, run,
    advance: (ms: number) => { clock += ms; },
    setTrack: (next: typeof track) => { track = next; },
    setRegister: (fn: typeof register) => { register = fn; },
  };
}

describe('parcels', () => {
  it('registers once, announces the first status, then only changes', async () => {
    const s = setup([parcel()]);
    s.setTrack({ SPXSG012345678901: info('SPXSG012345678901', 'InTransit', 'Arrived at sorting centre') });
    await s.run();
    expect(s.calls.map(c => c.path)).toEqual(['/register', '/gettrackinfo']);
    expect(s.calls[0].body).toEqual([{ number: 'SPXSG012345678901' }]); // carrier detected by 17TRACK
    expect(s.sent).toEqual(['Doot Doot.\n📦 Now tracking <b>Keyboard</b> with Shopee Express: in transit.\nArrived at sorting centre, Singapore\n<a href="https://t.17track.net/en#nums=SPXSG012345678901">Details</a>']);
    expect(s.states.get('p1')).toMatchObject({ registered: true, status: 'InTransit', carrierName: 'Shopee Express', carrierKey: 190271 });
    expect(s.states.get('p1')!.events).toHaveLength(2);

    // Nothing is due again for 30 minutes, and an unchanged status is quiet.
    await s.run();
    expect(s.calls).toHaveLength(2);
    s.advance(POLL_MS);
    await s.run();
    expect(s.calls.map(c => c.path)).toEqual(['/register', '/gettrackinfo', '/gettrackinfo']);
    expect(s.calls[2].body).toEqual([{ number: 'SPXSG012345678901', carrier: 190271 }]); // re-uses the matched carrier
    expect(s.sent).toHaveLength(1);

    s.setTrack({ SPXSG012345678901: info('SPXSG012345678901', 'OutForDelivery', 'Out for delivery', '2026-10-04T08:00:00+08:00') });
    s.advance(POLL_MS);
    await s.run();
    // The event only repeats the status, so just its place is added.
    expect(s.sent.at(-1)).toBe('Doot Doot.\n📦 <b>Keyboard</b>: out for delivery.\nSingapore\n<a href="https://t.17track.net/en#nums=SPXSG012345678901">Details</a>');
    s.setTrack({ SPXSG012345678901: info('SPXSG012345678901', 'Delivered', 'Delivered to recipient', '2026-10-04T13:00:00+08:00') });
    s.advance(POLL_MS);
    await s.run();
    expect(s.sent.at(-1)).toContain('📦 <b>Keyboard</b> was delivered ✓\nDelivered to recipient, Singapore');

    // Delivered parcels are only checked daily; archived ones not at all.
    s.advance(POLL_MS);
    await s.run();
    expect(s.calls.filter(c => c.path === '/gettrackinfo')).toHaveLength(4);
  });

  it('treats "already registered" as tracked, and retries refusals later without spending quota', async () => {
    const s = setup([parcel(), parcel({ id: 'p2', number: 'BADNUMBER1', label: 'Mystery' })]);
    s.setRegister(n => (n === 'BADNUMBER1' ? 'The tracking number format is invalid' : 'already'));
    s.setTrack({ SPXSG012345678901: info('SPXSG012345678901', 'InTransit', 'Arrived') });
    await s.run();
    expect(s.states.get('p1')!.registered).toBe(true);
    expect(s.states.get('p2')).toMatchObject({ registered: false, error: "17TRACK says this isn't a valid tracking number. Check it on the shop's order page." });
    await s.run();
    expect(s.calls.filter(c => c.path === '/register')).toHaveLength(1);
    s.advance(RETRY_REGISTER_MS);
    s.setRegister(() => 'ok');
    await s.run();
    expect(s.calls.filter(c => c.path === '/register').at(-1)!.body).toEqual([{ number: 'BADNUMBER1' }]);
    expect(s.states.get('p2')!.registered).toBe(true);
  });

  it('leaves archived parcels alone and explains a missing API key', async () => {
    const s = setup([parcel({ archived: true }), parcel({ id: 'p2', number: 'EB123456789SG' })], { configured: false });
    await s.run();
    expect(s.calls).toEqual([]);
    expect(s.states.has('p1')).toBe(false);
    expect(s.states.get('p2')).toMatchObject({ registered: false, error: NOT_CONFIGURED });
  });

  it("says nothing while the carrier hasn't scanned it yet", async () => {
    const s = setup([parcel()]);
    s.setTrack({ SPXSG012345678901: { number: 'SPXSG012345678901', carrier: 0, track_info: { latest_status: { status: 'NotFound' }, latest_event: null, tracking: { providers: [] } } } as never });
    await s.run();
    expect(s.sent).toEqual([]);
    expect(s.states.get('p1')).toMatchObject({ registered: true, status: 'NotFound' });
  });

  it('maps 17TRACK fields, lists parcels for /parcels, and feeds the briefing', () => {
    const mapped = toInfo(info('X', 'InTransit', 'Arrived', '2026-10-03T10:00:00+08:00', { time_metrics: { estimated_delivery_date: { from: null, to: '2026-10-05T18:00:00+08:00' } } }));
    expect(mapped).toMatchObject({ carrierName: 'Shopee Express', status: 'InTransit', latest: { text: 'Arrived', location: 'Singapore' }, eta: { to: '2026-10-05T18:00:00+08:00' } });
    const parcels = [parcel(), parcel({ id: 'p2', label: 'Books <2>' }), parcel({ id: 'p3', label: 'Old', archived: true })];
    const states = new Map<string, ParcelState>([
      ['p1', { registered: true, status: 'OutForDelivery' }],
      ['p2', { registered: true, status: 'InTransit', eta: { to: '2026-10-05T18:00:00+08:00' }, latest: { time: '', text: 'Arrived', location: '' } }],
      ['p3', { registered: true, status: 'Delivered' }],
    ]);
    expect(briefingParcels(parcels, states, '2026-10-05')).toEqual(['Keyboard: out for delivery', 'Books &lt;2&gt;: due today']);
    expect(briefingParcels(parcels, states, '2026-10-04')).toEqual(['Keyboard: out for delivery']);
    expect(parcelsReply(parcels, states)).toBe('Doot Doot.\n• <b>Keyboard</b>: Out for delivery\n• <b>Books &lt;2&gt;</b>: In transit (Arrived)');
    expect(parcelFor({ number: 'EB123456789SG', label: 'Books' }, 5)).toMatchObject({ number: 'EB123456789SG', label: 'Books', carrier: 0, archived: false, createdAt: 5, updatedAt: 5, revision: 0 });
  });
});
