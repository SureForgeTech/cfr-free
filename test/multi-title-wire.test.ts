import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { normalizeCitation, normalizeTitledCitation } from '../src/core/citations.js';
import { CFRService } from '../src/core/service.js';
import type { RawSection } from '../src/core/xml.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { createHttpServer } from '../src/titan/http-server.js';
import {
  createTestLogger,
  FIXTURE_SECTIONS,
  makeSection,
  openTempStore,
  type TempStore,
} from './helpers.js';

/**
 * The title-scoped wire surfaces.
 *
 * A multi-title index holds every enabled title's rows, so every read has
 * to say WHICH authority it answers with: a search defaults to Title 38
 * (the wire-compatible default), `title=32` runs in Title 32, and
 * `title=all` runs in every stored title with every hit labeled (the
 * multi-title design, 2026-11-13).
 *
 * The fixtures below are SYNTHETIC and local: a temp SQLite store, two
 * titles' rows, no network. Titles 32 and 38 both hold § 70.1, with
 * distinct text and inbound citation counts.
 */

const ISSUE_DATE = '2026-10-09';

/** Title 38's rows: the shared fixture set plus a provision Title 32 also has. */
const TITLE_38_SECTIONS: RawSection[] = [
  ...FIXTURE_SECTIONS,
  makeSection({
    citation: '70.1',
    part: '70',
    subpart: null,
    heading: 'Veteran discharge procedures.',
    path: '/title:38/chapter:I/part:70',
    text: 'Procedures for reviewing the discharge of a veteran under this part.',
    markdown: '## Veteran discharge procedures.',
  }),
];

/** Title 32's rows include a shared citation and provisions unique to Title 32. */
const TITLE_32_SECTIONS: RawSection[] = [
  makeSection({
    citation: '70.1',
    part: '70',
    subpart: null,
    subjectGroup: 'review',
    heading: 'Discharge review board procedures.',
    path: '/title:32/chapter:I/part:70',
    text: 'Procedures for reviewing the discharge of a member under the uniform code.',
    markdown: '## Discharge review board procedures.',
  }),
  makeSection({
    citation: '70.2',
    part: '70',
    subpart: null,
    subjectGroup: 'review',
    path: '/title:32/chapter:I/part:70',
    text: 'See § 70.1 for the discharge review procedures.',
  }),
  makeSection({
    citation: '3.12',
    part: '3',
    subpart: null,
    heading: 'Character of discharge.',
    path: '/title:32/chapter:I/part:3',
    text: 'The character of a member discharge depends on the conduct of the member.',
    markdown: '## Character of discharge.',
  }),
];

/** Title 32's own structure tree: its part 70 is not Title 38's part 70. */
const TITLE_32_STRUCTURE = {
  type: 'title',
  identifier: '32',
  label: 'Title 32—National Defense',
  children: [
    {
      type: 'chapter',
      identifier: 'I',
      label: 'Chapter I—Department of the Army',
      children: [
        {
          type: 'part',
          identifier: '70',
          label: 'Part 70—Discharge Review Board Procedures',
          children: [],
        },
      ],
    },
  ],
};

/** A store holding Title 38's rows and a Title 32 slice. */
function openMultiTitleStore(): TempStore {
  const temp = openTempStore({ sections: TITLE_38_SECTIONS });
  temp.store.replaceTitleWithBaseline(
    32,
    TITLE_32_SECTIONS,
    ISSUE_DATE,
    { 'title.32.structure_json': JSON.stringify(TITLE_32_STRUCTURE) },
    () => undefined,
  );
  return temp;
}

/** The service over a two-title store. */
function serviceOver(temp: TempStore): CFRService {
  return new CFRService(temp.store, 7);
}

describe('the title-scoped search', () => {
  it('answers in Title 38 when no title is named', () => {
    const temp = openMultiTitleStore();
    try {
      const result = serviceOver(temp).search({ query: 'discharge procedures' });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.every((hit) => hit.title === 38)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('answers in the named title', () => {
    const temp = openMultiTitleStore();
    try {
      const result = serviceOver(temp).search({ query: 'discharge procedures', title: 32 });
      expect(result.hits.length).toBeGreaterThan(0);
      expect(result.hits.every((hit) => hit.title === 32)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('labels every hit of an all-titles search', () => {
    const temp = openMultiTitleStore();
    try {
      const result = serviceOver(temp).search({ query: 'discharge procedures', title: 'all' });
      // The same citation exists in both titles: each copy is its own hit,
      // labeled with the authority it belongs to.
      const shared = result.hits.filter((hit) => hit.citation === '70.1');
      expect(shared.map((hit) => hit.title).sort()).toEqual([32, 38]);
      expect(result.hits.every((hit) => hit.title === 32 || hit.title === 38)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('pins every title’s copy of an untitled citation under `all`', () => {
    const temp = openMultiTitleStore();
    try {
      const { hits } = serviceOver(temp).search({ query: '70.1', title: 'all' });
      // The citation names no title, so EVERY title that holds it is pinned,
      // each labeled with its own authority. The ambiguity rule belongs to
      // the READ (which answers with one provision), not to a cross-title
      // search (which answers with a list).
      const pinned = hits.filter((hit) => hit.direct);
      expect(pinned.map((hit) => `${hit.title}:${hit.citation}`).sort()).toEqual([
        '32:70.1',
        '38:70.1',
      ]);
    } finally {
      temp.cleanup();
    }
  });

  it.each([
    { query: '32 CFR 70.1', title: undefined, citedTitle: 32 },
    { query: '38 CFR 70.1', title: 32, citedTitle: 38 },
  ])(
    'suggests the cited title without pinning $query in scope $title',
    ({ citedTitle, ...input }) => {
      const temp = openMultiTitleStore();
      try {
        const { hits, notice } = serviceOver(temp).search(input);
        expect(hits.filter((hit) => hit.direct)).toEqual([]);
        expect(notice).toContain(`Pass title=${citedTitle}`);
      } finally {
        temp.cleanup();
      }
    },
  );

  it('preserves the stale-index warning alongside the title guidance', () => {
    const temp = openMultiTitleStore();
    try {
      temp.store.setMeta('synced_at', '2020-01-01T00:00:00.000Z');
      const { notice } = serviceOver(temp).search({ query: '32 CFR 70.1' });
      expect(notice).toContain('local index is stale');
      expect(notice).toContain('Pass title=32');
    } finally {
      temp.cleanup();
    }
  });

  it.each([32, 'all'] as const)('pins only the cited title in scope %s', (title) => {
    const temp = openMultiTitleStore();
    try {
      const { hits, notice } = serviceOver(temp).search({ query: '32 CFR 70.1', title });
      expect(hits[0]).toMatchObject({ title: 32, citation: '70.1', direct: true });
      expect(hits.filter((hit) => hit.direct)).toHaveLength(1);
      expect(notice).toBeNull();
    } finally {
      temp.cleanup();
    }
  });

  it('keeps the per-title filters working inside the selected title', () => {
    const temp = openMultiTitleStore();
    try {
      const service = serviceOver(temp);
      const inTitle = service.search({ query: 'discharge procedures', title: 32, part: '70' });
      expect(inTitle.hits.length).toBeGreaterThan(0);
      expect(inTitle.hits.every((hit) => hit.part === '70')).toBe(true);
      // Part 4 belongs to Title 38: inside Title 32 it matches nothing.
      const otherPart = service.search({ query: 'discharge procedures', title: 32, part: '4' });
      expect(otherPart.hits).toEqual([]);
      expect(otherPart.total).toBe(0);
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a title that is not a CFR title', () => {
    const temp = openMultiTitleStore();
    try {
      const service = serviceOver(temp);
      expect(() => service.search({ query: 'discharge procedures', title: 99 })).toThrow(
        /the title number may be at most 50/,
      );
      expect(() => service.search({ query: 'discharge procedures', title: 'title' })).toThrow(
        /the title must be a CFR title number/,
      );
    } finally {
      temp.cleanup();
    }
  });

  it('accepts only canonical title scopes in strings', () => {
    const temp = openMultiTitleStore();
    try {
      const service = serviceOver(temp);
      const query = 'discharge procedures';
      for (const title of ['1', '9', '10', '32', '49', '50', 'all']) {
        expect(() => service.search({ query, title })).not.toThrow();
      }
      for (const title of ['0', '01', '032', ' 32', '32 ', '32\n', '51', 'ALL']) {
        expect(() => service.search({ query, title })).toThrow(
          expect.objectContaining({ code: 'invalid_input' }),
        );
      }
    } finally {
      temp.cleanup();
    }
  });

  it('uses the search scope or provision title in stale notices', () => {
    const temp = openMultiTitleStore();
    try {
      temp.store.setMeta('synced_at', '2020-01-01T00:00:00Z');
      const service = serviceOver(temp);
      const query = 'discharge procedures';
      expect(service.search({ query, title: 32 }).notice).toContain(
        '/on/<YYYY-MM-DD>/title-32/section-<citation>',
      );
      expect(service.search({ query, title: 'all' }).notice).toContain(
        '/on/<YYYY-MM-DD>/title-<title>/section-<citation>',
      );
      expect(service.getSection('32 CFR 70.1').notice).toContain(
        '/on/<YYYY-MM-DD>/title-32/section-<citation>',
      );
    } finally {
      temp.cleanup();
    }
  });
});

describe('the title-scoped section read', () => {
  it('reads Title 38 for an untitled citation held by both titles', () => {
    const temp = openMultiTitleStore();
    try {
      expect(serviceOver(temp).getSection('70.1')).toMatchObject({
        title: 38,
        heading: 'Veteran discharge procedures.',
      });
    } finally {
      temp.cleanup();
    }
  });

  it('returns not_found with hints for every other title holding an untitled citation', () => {
    const temp = openMultiTitleStore();
    try {
      temp.store.replaceTitleWithBaseline(
        33,
        [makeSection({ citation: '3.12', part: '3' })],
        ISSUE_DATE,
        {},
        () => undefined,
      );
      expect(() => serviceOver(temp).getSection('3.12')).toThrow(
        expect.objectContaining({
          code: 'not_found',
          message: expect.stringMatching(
            /Title 32 holds 3\.12; pass title=32.*Title 33 holds 3\.12; pass title=33/,
          ),
        }),
      );
    } finally {
      temp.cleanup();
    }
  });

  it("serves the named title's provision", () => {
    const temp = openMultiTitleStore();
    try {
      const section = serviceOver(temp).getSection('70.1', 32);
      expect(section.title).toBe(32);
      expect(section.heading).toBe('Discharge review board procedures.');
    } finally {
      temp.cleanup();
    }
  });

  it('reports citation support from the provision’s own title', () => {
    const temp = openMultiTitleStore();
    try {
      const service = serviceOver(temp);
      expect(service.getSection('70.1', 32).citationSupport).toEqual({
        subjectGroup: 1,
        part: 1,
        total: 1,
      });
      expect(service.getSection('70.1', 38).citationSupport).toEqual({
        subjectGroup: 0,
        part: 0,
        total: 0,
      });
    } finally {
      temp.cleanup();
    }
  });

  it('requires an explicit title to read a citation held only in Title 32', () => {
    const temp = openMultiTitleStore();
    try {
      const service = serviceOver(temp);
      expect(() => service.getSection('70.2')).toThrow(
        expect.objectContaining({
          code: 'not_found',
          message: expect.stringContaining('Title 32 holds 70.2; pass title=32'),
        }),
      );
      expect(service.getSection('70.2', 32)).toMatchObject({ citation: '70.2', title: 32 });
    } finally {
      temp.cleanup();
    }
  });

  it('refuses `all` on a read — it is a search-only scope', () => {
    const temp = openMultiTitleStore();
    try {
      expect(() => serviceOver(temp).getSection('70.1', 'all')).toThrow(/search-only scope/);
    } finally {
      temp.cleanup();
    }
  });

  it('resolves a citation that names its own title', () => {
    const temp = openMultiTitleStore();
    try {
      // The display form this product prints for another title must read
      // back to the provision it was copied from.
      const section = serviceOver(temp).getSection('32 CFR § 70.1');
      expect(section.title).toBe(32);
      expect(section.heading).toBe('Discharge review board procedures.');
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a citation that names a different title than the read asked for', () => {
    const temp = openMultiTitleStore();
    try {
      expect(() => serviceOver(temp).getSection('32 CFR § 70.1', 38)).toThrow(
        /names Title 32 but the read asked for Title 38/,
      );
    } finally {
      temp.cleanup();
    }
  });

  it('carries the title it belongs to', () => {
    const temp = openMultiTitleStore();
    try {
      expect(serviceOver(temp).getSection('4.125').title).toBe(38);
      expect(serviceOver(temp).getSection('4.125', 38).title).toBe(38);
    } finally {
      temp.cleanup();
    }
  });
});

describe('the display form and the source URLs', () => {
  it('names the title the hit belongs to', () => {
    const temp = openMultiTitleStore();
    try {
      const hit = serviceOver(temp).search({ query: '70.1', title: 32 }).hits[0];
      expect(hit?.citation).toBe('70.1');
      expect(hit?.citationDisplay).toBe('32 CFR § 70.1');
      expect(hit?.sourceUrl).toBe('https://www.ecfr.gov/current/title-32/section-70.1');
      expect(hit?.sourceUrlAtIndexDate).toBe(
        `https://www.ecfr.gov/on/${ISSUE_DATE}/title-32/section-70.1`,
      );
      // The part title comes from the hit's OWN title's structure tree.
      expect(hit?.partTitle).toBe('Discharge Review Board Procedures');
    } finally {
      temp.cleanup();
    }
  });

  it('names the title in a non-38 appendix display citation and reads it back', () => {
    const temp = openMultiTitleStore();
    try {
      const citation = 'Appendix A to Part 70';
      temp.store.replaceTitleWithBaseline(
        32,
        [...TITLE_32_SECTIONS, makeSection({ citation, kind: 'appendix', part: '70' })],
        ISSUE_DATE,
        {},
        () => undefined,
      );
      const service = serviceOver(temp);
      const hit = service.search({ query: citation, title: 32 }).hits[0];
      expect(hit?.citationDisplay).toBe('32 CFR Appendix A to Part 70');
      expect(service.getSection(hit?.citationDisplay ?? '')).toMatchObject({
        citation,
        kind: 'appendix',
        title: 32,
      });
    } finally {
      temp.cleanup();
    }
  });

  it("keeps Title 38's published display form and URLs", () => {
    const temp = openMultiTitleStore();
    try {
      const hit = serviceOver(temp).search({ query: '38 CFR 4.130' }).hits[0];
      expect(hit?.citationDisplay).toBe('38 C.F.R. § 4.130');
      expect(hit?.sourceUrl).toBe('https://www.ecfr.gov/current/title-38/section-4.130');
      expect(hit?.sourceUrlAtIndexDate).toBe(
        `https://www.ecfr.gov/on/${ISSUE_DATE}/title-38/section-4.130`,
      );
    } finally {
      temp.cleanup();
    }
  });

  it('gives a section read the URLs of its own title', () => {
    const temp = openMultiTitleStore();
    try {
      const section = serviceOver(temp).getSection('70.1', 32);
      expect(section.sourceUrl).toBe('https://www.ecfr.gov/current/title-32/section-70.1');
      expect(section.sourceUrlAtIndexDate).toBe(
        `https://www.ecfr.gov/on/${ISSUE_DATE}/title-32/section-70.1`,
      );
    } finally {
      temp.cleanup();
    }
  });
});

describe('the MCP surface', () => {
  it('searches a named title and labels every hit', async () => {
    const temp = openMultiTitleStore();
    const server = buildMcpServer(serviceOver(temp), createTestLogger());
    const client = new Client({ name: 'multi-title-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({
        name: 'search_regulations',
        arguments: { query: 'discharge procedures', title: 32 },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(result.isError).toBeFalsy();
      const hits = result.structuredContent?.['hits'] as Array<{ title: number }>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.every((hit) => hit.title === 32)).toBe(true);
    } finally {
      await client.close();
      await server.close();
      temp.cleanup();
    }
  });

  it('reads a section in a named title', async () => {
    const temp = openMultiTitleStore();
    const server = buildMcpServer(serviceOver(temp), createTestLogger());
    const client = new Client({ name: 'multi-title-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({
        name: 'get_section',
        arguments: { citation: '70.1', title: 32 },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent?.['title']).toBe(32);
      expect(result.structuredContent?.['heading']).toBe('Discharge review board procedures.');
    } finally {
      await client.close();
      await server.close();
      temp.cleanup();
    }
  });

  it('prefers Title 38 for an untitled read', async () => {
    const temp = openMultiTitleStore();
    const server = buildMcpServer(serviceOver(temp), createTestLogger());
    const client = new Client({ name: 'multi-title-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({
        name: 'get_section',
        arguments: { citation: '70.1' },
      })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        title: 38,
        heading: 'Veteran discharge procedures.',
      });
    } finally {
      await client.close();
      await server.close();
      temp.cleanup();
    }
  });
});

describe('the HTTP surface', () => {
  /** The server over a two-title store, plus its base URL. */
  async function serve(temp: TempStore): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createHttpServer(serviceOver(temp), createTestLogger());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${address.port}`,
      close: async () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    };
  }

  it('searches a named title and labels every hit', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/search?q=discharge+procedures&title=32`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { hits: Array<{ title: number }> };
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits.every((hit) => hit.title === 32)).toBe(true);
    } finally {
      await server.close();
      temp.cleanup();
    }
  });

  it('reads a section in a named title', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/sections/70.1?title=32`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { title: number; heading: string };
      expect(body.title).toBe(32);
      expect(body.heading).toBe('Discharge review board procedures.');
    } finally {
      await server.close();
      temp.cleanup();
    }
  });

  it('prefers Title 38 for an untitled read', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/sections/70.1`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        title: 38,
        heading: 'Veteran discharge procedures.',
      });
    } finally {
      await server.close();
      temp.cleanup();
    }
  });

  it('returns HTTP 404 with title guidance for an untitled citation missing from Title 38', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/sections/70.2`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: 'not_found',
        message: expect.stringContaining('Title 32 holds 70.2; pass title=32'),
      });
    } finally {
      await server.close();
      temp.cleanup();
    }
  });

  it('refuses `all` on a section read', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/sections/70.1?title=all`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { message: string };
      expect(body.message).toContain('search-only scope');
    } finally {
      await server.close();
      temp.cleanup();
    }
  });
});

describe('the title-named citation parser', () => {
  it('reads the title a citation names', () => {
    expect(normalizeTitledCitation('32 CFR § 70.1')).toEqual({
      kind: 'section',
      citation: '70.1',
      title: 32,
    });
    expect(normalizeTitledCitation('38 C.F.R. § 4.130')).toEqual({
      kind: 'section',
      citation: '4.130',
      title: 38,
    });
    expect(normalizeTitledCitation('32 CFR Appendix A to Part 70')).toEqual({
      kind: 'appendix',
      citation: 'Appendix A to Part 70',
      title: 32,
    });
  });

  it('refuses a citation that names no title, or one that is not a CFR title', () => {
    expect(normalizeTitledCitation('4.125')).toBeNull();
    expect(normalizeTitledCitation('§ 4.125')).toBeNull();
    expect(normalizeTitledCitation('99 CFR 4.125')).toBeNull();
    expect(normalizeTitledCitation('32 CFR')).toBeNull();
    expect(normalizeTitledCitation('')).toBeNull();
  });

  it("leaves the Title-38 parser's own contract alone", () => {
    // `normalizeCitation` is the Title-38 reader's parser: it accepts the
    // dotted legal form for Title 38 and refuses another title's.
    expect(normalizeCitation('38 C.F.R. § 4.130')).toEqual({
      kind: 'section',
      citation: '4.130',
    });
    expect(normalizeCitation('42 C.F.R. § 4.125')).toBeNull();
  });
});

describe("the CLI's title flag", () => {
  it('searches the named title and carries the title in its JSON output', async () => {
    const temp = openMultiTitleStore();
    const out: string[] = [];
    const err: string[] = [];
    try {
      const code = await main(['search', '--title', '32', '--json', 'discharge procedures'], {
        out: (chunk) => out.push(chunk),
        err: (chunk) => err.push(chunk),
        env: {
          CFR_INDEX_PATH: temp.indexPath,
          CFR_AUTO_SYNC: '0',
          CFR_MAX_AGE_DAYS: '365',
          CFR_LOG_LEVEL: 'error',
        },
      });
      expect(code).toBe(0);
      expect(err.join('')).toBe('');
      const payload = JSON.parse(out.join('')) as {
        hits: Array<{ title: number; citation: string }>;
      };
      expect(payload.hits.length).toBeGreaterThan(0);
      expect(payload.hits.every((hit) => hit.title === 32)).toBe(true);
    } finally {
      temp.cleanup();
    }
  });

  it('refuses a title that is not a CFR title, as a usage error', async () => {
    const temp = openMultiTitleStore();
    const err: string[] = [];
    try {
      const code = await main(['search', '--title', '99', 'discharge procedures'], {
        out: () => undefined,
        err: (chunk) => err.push(chunk),
        env: {
          CFR_INDEX_PATH: temp.indexPath,
          CFR_AUTO_SYNC: '0',
          CFR_MAX_AGE_DAYS: '365',
          CFR_LOG_LEVEL: 'error',
        },
      });
      expect(code).toBe(2);
      expect(err.join('')).toContain('the title number may be at most 50');
    } finally {
      temp.cleanup();
    }
  });
});
