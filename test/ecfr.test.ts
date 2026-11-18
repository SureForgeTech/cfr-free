import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FULL_TITLE_XML_TTL_MS,
  DEFAULT_MAX_CONCURRENT_FETCHES,
  DEFAULT_MAX_QUEUED_FETCHES,
  EcfrApi,
  FULL_TITLE_XML_MEMO_CAP,
} from '../src/core/ecfr.js';
import { UpstreamFormatError } from '../src/core/errors.js';
import { HttpClient } from '../src/core/http-client.js';
import type { FetchLike } from '../src/core/http-client.js';
import { SemaphoreOverflowError } from '../src/core/semaphore.js';

const DATE = '2026-01-01';
const OTHER_DATE = '2026-06-01';

function makeApi(fetchFn: FetchLike): EcfrApi {
  return new EcfrApi(
    new HttpClient({
      fetchFn,
      sleep: async () => undefined,
      retries: 0,
      retryDelayMs: 0,
    }),
  );
}

/** A stub that records the dates it was asked for. */
function countingFetch(requested: string[]): FetchLike {
  return async (input) => {
    const url = new URL(String(input));
    const match = /\/full\/(\d{4}-\d{2}-\d{2})\/title-38\.xml$/.exec(url.pathname);
    requested.push(match?.[1] ?? url.pathname);
    return new Response('<ECFR></ECFR>', {
      status: 200,
      headers: { 'content-type': 'application/xml' },
    });
  };
}

/** Wait until the predicate holds, so the test does not count microtasks. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !predicate(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe('EcfrApi.getFullTitleXml', () => {
  it('fetches the same date once', async () => {
    // A point-in-time document does not change: the second read of the
    // same date is the same bytes, and the repeated identical fetches are
    // what made the upstream amplification cheap.
    const requested: string[] = [];
    const api = makeApi(countingFetch(requested));

    const first = await api.getFullTitleXml(DATE);
    const second = await api.getFullTitleXml(DATE);

    expect(second).toBe(first);
    expect(requested).toEqual([DATE]);
  });

  it('fetches a different date', async () => {
    const requested: string[] = [];
    const api = makeApi(countingFetch(requested));

    await api.getFullTitleXml(DATE);
    await api.getFullTitleXml(OTHER_DATE);

    expect(requested).toEqual([DATE, OTHER_DATE]);
  });

  it('bounds the document fetches in flight at once', async () => {
    // The request budget bounds how fast these start; nothing else bounded
    // how many could run at once, and each one holds a parsed document.
    let running = 0;
    let peak = 0;
    const api = makeApi(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return new Response('<ECFR></ECFR>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    });

    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05'];
    await Promise.all(dates.map((date) => api.getFullTitleXml(date)));

    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it('serves concurrent readers of the same date from one fetch', async () => {
    // The repeated identical fetches are what made the upstream
    // amplification cheap: a burst of identical requests must not become
    // a burst of identical downloads.
    let fetches = 0;
    let release: (() => void) | undefined;
    const api = makeApi(async () => {
      fetches += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return new Response('<ECFR></ECFR>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    });

    const readers = [
      api.getFullTitleXml(DATE),
      api.getFullTitleXml(DATE),
      api.getFullTitleXml(DATE),
    ];
    await waitFor(() => fetches === 1);
    // The one fetch is still in flight: the other readers are waiting on
    // it, not starting their own.
    expect(fetches).toBe(1);
    release?.();

    const documents = await Promise.all(readers);
    expect(fetches).toBe(1);
    expect(documents[0]).toBe(documents[1]);
    expect(documents[1]).toBe(documents[2]);
  });

  it('evicts the least recently used document, not the oldest', async () => {
    const requested: string[] = [];
    const api = new EcfrApi(
      new HttpClient({
        fetchFn: countingFetch(requested),
        sleep: async () => undefined,
        retries: 0,
        retryDelayMs: 0,
      }),
      undefined,
      { fullTitleXmlMemoCap: 2 },
    );

    await api.getFullTitleXml('2026-01-01');
    await api.getFullTitleXml('2026-01-02');
    // The first date is read again: it is now the MOST recently used.
    await api.getFullTitleXml('2026-01-01');
    // The third date evicts the least recently used one — the second date,
    // not the first.
    await api.getFullTitleXml('2026-01-03');
    expect(requested).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);

    // The hot document survived: reading it again costs no fetch.
    await api.getFullTitleXml('2026-01-01');
    expect(requested).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);
    // The cold one was evicted: reading it again fetches it again.
    await api.getFullTitleXml('2026-01-02');
    expect(requested).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-02']);
  });

  it('keeps four documents for five minutes by default', async () => {
    // The published contract (SPEC §5): the memo holds at most four
    // documents and reuses one for five minutes.
    expect(FULL_TITLE_XML_MEMO_CAP).toBe(4);
    expect(DEFAULT_FULL_TITLE_XML_TTL_MS).toBe(5 * 60_000);

    const requested: string[] = [];
    const api = makeApi(countingFetch(requested));
    const dates = ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
    for (const date of dates) await api.getFullTitleXml(date);
    // Four documents fit: none of them is fetched twice.
    for (const date of dates) await api.getFullTitleXml(date);
    expect(requested).toEqual(dates);
    // The fifth evicts the first.
    await api.getFullTitleXml('2026-01-05');
    await api.getFullTitleXml('2026-01-01');
    expect(requested).toEqual([...dates, '2026-01-05', '2026-01-01']);
  });

  it('fetches a document again once its reuse window has passed', async () => {
    const requested: string[] = [];
    const api = new EcfrApi(
      new HttpClient({
        fetchFn: countingFetch(requested),
        sleep: async () => undefined,
        retries: 0,
        retryDelayMs: 0,
      }),
      undefined,
      { fullTitleXmlTtlMs: 0 },
    );

    await api.getFullTitleXml(DATE);
    await api.getFullTitleXml(DATE);

    expect(requested).toEqual([DATE, DATE]);
  });

  it('refuses a fetch once the wait queue is full', async () => {
    // The published contract (SPEC §5): four fetches run at a time and
    // SIXTEEN may wait for a permit. The CONSTANT that said sixteen was
    // pinned to the SPEC, but the number the semaphore was actually
    // CONSTRUCTED with was not: a hardcoded thousand waiters there left
    // every test green, and the published "sixteen waiting" became a lie
    // the code never enforced.
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const api = makeApi(async () => {
      await gate;
      return new Response('<ECFR></ECFR>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    });

    // One more request than the bound allows: the last one must be the
    // one refused, so the refusal happens exactly AT the bound.
    const bound = DEFAULT_MAX_CONCURRENT_FETCHES + DEFAULT_MAX_QUEUED_FETCHES;
    const requests = Array.from({ length: bound + 1 }, (_, index) =>
      api.getFullTitleXml(`2026-01-${String(index + 1).padStart(2, '0')}`),
    );
    // Track what settles: a PARKED request stays pending, and a REFUSED
    // one rejects at once.
    const settled = requests.map(() => false);
    requests.forEach((request, index) => {
      void request.then(
        () => {
          settled[index] = true;
        },
        () => {
          settled[index] = true;
        },
      );
    });
    // Let the queueing and the refusals settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Everything up to the bound is parked, not refused...
    expect(
      settled.slice(0, bound).some((done) => done),
      'every fetch up to the bound must be parked, not refused',
    ).toBe(false);
    // ...and the one past it is refused at once, naming the bound it hit.
    expect(settled[bound], 'the fetch past the queue bound must be refused').toBe(true);
    await expect(requests[bound]).rejects.toBeInstanceOf(SemaphoreOverflowError);
    await expect(requests[bound]).rejects.toThrow(
      `${DEFAULT_MAX_QUEUED_FETCHES} upstream fetches are already waiting`,
    );

    // Let the parked fetches finish so nothing is left running.
    openGate?.();
    await Promise.allSettled(requests);
  });
});

describe('EcfrApi.getTitleSchedule', () => {
  it('maps a malformed titles.json to an UpstreamFormatError, not a bare schema fault', async () => {
    // CR-21: a body that is not eCFR's contract is an upstream data fault —
    // it must answer 502 downstream, not collapse into a generic 500 that
    // reads as our bug.
    const api = makeApi(
      async () =>
        new Response(JSON.stringify({ titles: 'not-an-array' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(api.getTitleSchedule()).rejects.toBeInstanceOf(UpstreamFormatError);
  });
});

describe('EcfrApi title parameterization', () => {
  /** Records every requested pathname and serves a body naming the title. */
  function recordingFetch(paths: string[]): FetchLike {
    return async (input) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      if (url.pathname.endsWith('/titles.json')) {
        return new Response(
          JSON.stringify({
            titles: [
              {
                number: 32,
                name: 'National Defense',
                latest_issue_date: DATE,
                up_to_date_as_of: DATE,
                latest_amended_on: DATE,
              },
              {
                number: 38,
                name: 'Pensions',
                latest_issue_date: DATE,
                up_to_date_as_of: DATE,
                latest_amended_on: DATE,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      const title = /title-(\d+)\.(?:xml|json)$/.exec(url.pathname)?.[1] ?? 'unknown';
      if (url.pathname.includes('/structure/')) {
        return new Response(
          JSON.stringify({
            type: 'title',
            identifier: title,
            label: `Title ${title}`,
            children: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(`<ECFR><TITLE>${title}</TITLE></ECFR>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    };
  }

  it('requests the title-32 URLs for structure and full-title fetches', async () => {
    const paths: string[] = [];
    const api = makeApi(recordingFetch(paths));

    await api.getStructureJson(DATE, 32);
    await api.getFullTitleXml(DATE, 32);
    // The default stays Title 38 — existing call sites are source-compatible.
    await api.getStructureJson(DATE);
    await api.getFullTitleXml(DATE);

    expect(paths).toContain(`/api/versioner/v1/structure/${DATE}/title-32.json`);
    expect(paths).toContain(`/api/versioner/v1/full/${DATE}/title-32.xml`);
    expect(paths).toContain(`/api/versioner/v1/structure/${DATE}/title-38.json`);
    expect(paths).toContain(`/api/versioner/v1/full/${DATE}/title-38.xml`);
    expect(paths.some((p) => p.includes('title-32'))).toBe(true);
  });

  it('resolves the schedule for a named title and rejects a title missing upstream', async () => {
    const api = makeApi(recordingFetch([]));
    await expect(api.getTitleSchedule(32)).resolves.toEqual({ upToDateAsOf: DATE });

    const only38 = makeApi(
      async () =>
        new Response(
          JSON.stringify({
            titles: [
              {
                number: 38,
                name: 'Pensions',
                latest_issue_date: DATE,
                up_to_date_as_of: DATE,
                latest_amended_on: DATE,
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(only38.getTitleSchedule(32)).rejects.toThrow(/does not include title 32/);
  });

  it('memoizes title 32 and title 38 separately for the same date', async () => {
    // The memo key is title+date: the two authorities' documents for one
    // date are different documents and must never share a cache entry.
    const paths: string[] = [];
    const api = makeApi(recordingFetch(paths));

    const xml32 = await api.getFullTitleXml(DATE, 32);
    const xml38 = await api.getFullTitleXml(DATE);
    expect(xml32).not.toBe(xml38);
    expect(xml32).toContain('<TITLE>32</TITLE>');
    expect(xml38).toContain('<TITLE>38</TITLE>');
    expect(paths.filter((p) => p.includes('/full/'))).toHaveLength(2);

    // Re-reading the same title+date is memoized — no third fetch.
    expect(await api.getFullTitleXml(DATE, 32)).toBe(xml32);
    expect(await api.getFullTitleXml(DATE)).toBe(xml38);
    expect(paths.filter((p) => p.includes('/full/'))).toHaveLength(2);
  });

  it('serves concurrent readers of one title from one fetch, per title', async () => {
    let fetches = 0;
    // One resolver PER in-flight fetch: two titles fetch at once, so a single
    // slot would release only one of them and leave the other pending.
    const releases: Array<() => void> = [];
    const api = makeApi(async () => {
      fetches += 1;
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return new Response('<ECFR></ECFR>', {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    });

    const readers = [
      api.getFullTitleXml(DATE, 32),
      api.getFullTitleXml(DATE, 32),
      api.getFullTitleXml(DATE),
    ];
    await waitFor(() => fetches === 2);
    // Two titles in flight: one fetch EACH — the single-flight is per title.
    expect(fetches).toBe(2);
    for (const release of releases) release();
    await Promise.all(readers);
    expect(fetches).toBe(2);
  });

  it('rejects title numbers outside 1-50 and non-integers', async () => {
    const api = makeApi(recordingFetch([]));
    await expect(api.getFullTitleXml(DATE, 0)).rejects.toThrow(/invalid CFR title/);
    await expect(api.getFullTitleXml(DATE, 51)).rejects.toThrow(/invalid CFR title/);
    await expect(api.getFullTitleXml(DATE, 38.5)).rejects.toThrow(/invalid CFR title/);
    await expect(api.getStructureJson(DATE, -1)).rejects.toThrow(/invalid CFR title/);
    await expect(api.getTitleSchedule(51)).rejects.toThrow(/invalid CFR title/);
  });
});
