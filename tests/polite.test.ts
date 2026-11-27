import { describe, expect, it } from 'vitest';
import { HttpError, NetworkError, PoliteFetcher } from '../src/enrich/musicbrainz';

/** A clock that only moves when the fetcher sleeps, so waits can be asserted exactly. */
class FakeTime {
  now = 10_000;
  readonly sleeps: number[] = [];
  sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.now += ms;
  };
}

/** Answers from a script instead of the network: a status and an optional Retry-After, or null to fail the connection. */
function scripted(script: ([number, string?] | null)[]) {
  const server = {
    calls: 0,
    fetch: (async () => {
      const step = script[Math.min(server.calls, script.length - 1)];
      server.calls++;
      if (step === null) throw new TypeError('Failed to fetch');
      const [status, retryAfter] = step;
      return new Response('{"ok":true}', { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} });
    }) as typeof fetch,
  };
  return server;
}

const URL = 'https://musicbrainz.org/ws/2/recording/x';

function fetcher(time: FakeTime, server: { fetch: typeof fetch }, maxRetries?: number): PoliteFetcher {
  return new PoliteFetcher({ fetch: server.fetch, sleep: time.sleep, now: () => time.now, maxRetries });
}

describe('PoliteFetcher', () => {
  it('spaces requests at least a second apart', async () => {
    const time = new FakeTime();
    const client = fetcher(time, scripted([[200]]));

    for (let i = 0; i < 3; i++) expect(await client.getJson(URL)).toEqual({ ok: true });

    // The first goes straight out; each later one waits out the rest of the interval.
    expect(time.sleeps).toEqual([1_100, 1_100]);
  });

  it('waits out the interval after a request made before the page was reloaded', async () => {
    const time = new FakeTime();
    let last = time.now - 300;
    const client = new PoliteFetcher({ fetch: scripted([[200]]).fetch, sleep: time.sleep, now: () => time.now, lastRequest: { get: () => last, set: (at) => (last = at) } });

    await client.getJson(URL);

    expect(time.sleeps).toEqual([800]);
    expect(last).toBe(10_800);
  });

  it('is not held up by a remembered time that lies in the future', async () => {
    const time = new FakeTime();
    const client = new PoliteFetcher({ fetch: scripted([[200]]).fetch, sleep: time.sleep, now: () => time.now, lastRequest: { get: () => time.now + 3_600_000, set: () => {} } });

    await client.getJson(URL);

    expect(time.sleeps).toEqual([1_100]);
  });

  it('retries a busy server after the wait it asks for', async () => {
    const time = new FakeTime();
    const server = scripted([[503, '1'], [503, '1'], [200]]);

    expect(await fetcher(time, server).getJson(URL)).toEqual({ ok: true });

    expect(server.calls).toBe(3);
    // Retry-After plus a little more each time; then the usual spacing still applies.
    expect(time.sleeps).toEqual([1_000, 100, 1_500]);
  });

  it('doubles the back-off when no wait is stated', async () => {
    const time = new FakeTime();
    const server = scripted([[503], [429], [200]]);

    expect(await fetcher(time, server).getJson(URL)).toEqual({ ok: true });

    expect(time.sleeps).toEqual([2_000, 4_000]);
  });

  it('reports a server that stays busy instead of retrying forever', async () => {
    const time = new FakeTime();
    const server = scripted([[503, '1']]);

    const error = await fetcher(time, server, 2)
      .getJson(URL)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(503);
    expect(server.calls).toBe(3);
  });

  it('reports other error answers at once', async () => {
    const time = new FakeTime();
    const server = scripted([[404]]);

    await expect(fetcher(time, server).getJson(URL)).rejects.toBeInstanceOf(HttpError);
    expect(server.calls).toBe(1);
  });

  it('retries a broken connection a few times and then says the network is down', async () => {
    const time = new FakeTime();
    const server = scripted([null]);

    await expect(fetcher(time, server).getJson(URL)).rejects.toBeInstanceOf(NetworkError);
    expect(server.calls).toBe(4);
  });

  it('stops at once when it is cancelled', async () => {
    const time = new FakeTime();
    const abort = new AbortController();
    const server = {
      calls: 0,
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        server.calls++;
        abort.abort();
        init?.signal?.throwIfAborted();
        return new Response('{}');
      }) as typeof fetch,
    };

    await expect(fetcher(time, server).getJson(URL, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(server.calls).toBe(1);
  });
});
