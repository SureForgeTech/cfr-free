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
 * titles' rows, no network. The Title-32 rows deliberately share one
 * citation with Title 38 ('70.1'), which is what makes the ambiguity rule
 * observable.
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

/** Title 32's rows: one provision Title 38 also has, and one only it has. */
const TITLE_32_SECTIONS: RawSection[] = [
  makeSection({
    citation: '70.1',
    part: '70',
    subpart: null,
    heading: 'Discharge review board procedures.',
    path: '/title:32/chapter:I/part:70',
    text: 'Procedures for reviewing the discharge of a member under the uniform code.',
    markdown: '## Discharge review board procedures.',
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
});

describe('the title-scoped section read', () => {
  it('refuses an ambiguous citation and names the titles', () => {
    const temp = openMultiTitleStore();
    try {
      expect(() => serviceOver(temp).getSection('70.1')).toThrow(
        /exists in more than one stored title \(32, 38\)/,
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

  it('serves a citation only ONE title holds, without a title parameter', () => {
    const temp = openMultiTitleStore();
    try {
      const section = serviceOver(temp).getSection('3.12');
      expect(section.title).toBe(32);
      expect(section.heading).toBe('Character of discharge.');
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

  it('refuses an ambiguous citation, naming the titles', async () => {
    const temp = openMultiTitleStore();
    const server = buildMcpServer(serviceOver(temp), createTestLogger());
    const client = new Client({ name: 'multi-title-test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = (await client.callTool({
        name: 'get_section',
        arguments: { citation: '70.1' },
      })) as { isError?: boolean; content: Array<{ text?: string }> };
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('exists in more than one stored title (32, 38)');
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

  it('refuses an ambiguous citation with a 400 naming the titles', async () => {
    const temp = openMultiTitleStore();
    const server = await serve(temp);
    try {
      const response = await fetch(`${server.url}/api/v1/sections/70.1`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; message: string };
      expect(body.error).toBe('invalid_input');
      expect(body.message).toContain('exists in more than one stored title (32, 38)');
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
