/** A normalized citation that can be looked up in the local index. */
export type ParsedCitation =
  | { readonly kind: 'section'; readonly citation: string }
  | { readonly kind: 'appendix'; readonly citation: string };

/** A citation that NAMES the CFR title it belongs to. */
export interface TitledCitation {
  readonly kind: 'section' | 'appendix';
  readonly citation: string;
  /** The CFR title the citation names (1-50). */
  readonly title: number;
}

/** `4.125`, `4.124a`, `17.103` … (section numbers within a part). */
const SECTION_RE = /^\d{1,3}\.\d{1,4}[a-z]{0,3}$/i;
const MAX_CITATION_LENGTH = 120;

/** The CFR titles eCFR serves (49 titles plus the reserved ones). */
const MIN_TITLE = 1;
const MAX_TITLE = 50;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * The citation BODY: the provision a citation names, with no title prefix.
 *
 * One implementation, shared by both parsers below, so the two can never
 * disagree about what a citation body is.
 */
function parseCitationBody(text: string): ParsedCitation | null {
  if (/^appendix\b/i.test(text)) return { kind: 'appendix', citation: text };

  // The dotted form matters: `displayCitation` emits `38 C.F.R. § 4.130`
  // (the paste-ready legal form), so the parser must accept exactly what
  // the product hands the user — otherwise copying a citation the tool
  // printed back into the tool yields "invalid input" (review finding
  // P1-03). The optional dots are per letter and flat, so no ReDoS shape.
  const withoutSection = text.replace(/^§\s*/, '');
  const candidate = withoutSection.replace(/\.$/, '').trim();
  if (!SECTION_RE.test(candidate)) return null;
  return { kind: 'section', citation: candidate.toLowerCase() };
}

/**
 * Parse user-supplied citation text into a canonical lookup key.
 *
 * Accepts bare citations (`4.125`), `§`-prefixed forms (`§ 4.125`), full
 * citations (`38 CFR 4.125`, `38 C.F.R. § 4.125` — the dotted legal form
 * the product itself emits), and appendix names (`Appendix A to Part 4`).
 *
 * The Title-38 forms only: a citation naming another title is refused
 * here (a frozen expectation, test/citations.test.ts) because this parser
 * is the Title-38 reader's. {@link normalizeTitledCitation} is the
 * multi-title reader's counterpart.
 *
 * @returns `null` when the input is not a recognizable citation.
 */
export function normalizeCitation(input: string): ParsedCitation | null {
  const trimmed = collapseWhitespace(input);
  if (trimmed.length === 0 || trimmed.length > MAX_CITATION_LENGTH) return null;
  if (/^appendix\b/i.test(trimmed)) return { kind: 'appendix', citation: trimmed };
  const withoutTitle = trimmed
    .replace(/^38\s+c\.?f\.?r\.?\s*/i, '')
    .replace(/^c\.?f\.?r\.?\s*/i, '');
  return parseCitationBody(withoutTitle);
}

/**
 * Parse a citation that NAMES its CFR title (`32 CFR § 70.1`,
 * `38 C.F.R. § 4.130`).
 *
 * WHY A SECOND PARSER. {@link normalizeCitation} is the Title-38 reader's
 * citation parser: it accepts the dotted legal form the product emits for
 * Title 38 and REFUSES a citation naming any other title — a frozen
 * expectation (test/citations.test.ts). A multi-title index must also read
 * a citation that names the title it belongs to, for two reasons: the
 * display form this product prints for another title (`32 CFR § 70.1`)
 * would otherwise not be readable by its own reader (the round-trip
 * P1-03 is about), and a citation that names its title is UNAMBIGUOUS —
 * it settles the very ambiguity an untitled citation raises when two
 * titles hold the same provision.
 *
 * The two parsers share one body parser, so they cannot disagree about
 * what a citation body is; they differ only in the title prefix they
 * accept.
 *
 * @returns `null` when the input names no title, or names one that is not
 *   a CFR title.
 */
export function normalizeTitledCitation(input: string): TitledCitation | null {
  const trimmed = collapseWhitespace(input);
  if (trimmed.length === 0 || trimmed.length > MAX_CITATION_LENGTH) return null;
  const match = /^(\d{1,2})\s+c\.?f\.?r\.?\.?\s*(.*)$/i.exec(trimmed);
  if (match === null) return null;
  const title = Number(match[1]);
  if (!Number.isInteger(title) || title < MIN_TITLE || title > MAX_TITLE) return null;
  const body = parseCitationBody(match[2] ?? '');
  if (body === null) return null;
  return { kind: body.kind, citation: body.citation, title };
}

/**
 * The one provision in a parsed document that a citation names.
 *
 * CR-17 found two functions named `findProvision` with the same intent and
 * DIFFERENT matching rules: the point-in-time read folded both sides to
 * lower case, while the redline folded both sides for an appendix but
 * compared a section against `target.citation` alone — relying on an
 * invariant (`normalizeCitation` already lower-cases) that is invisible at
 * the call site and easy to break. A future change to one would not have
 * reached the other.
 *
 * The rule now lives in one place:
 *
 * - both sides are compared case-INSENSITIVELY. The corpus stores section
 *   citations lower-cased (`4.124A` is `4.124a`), and the store is this
 *   repo's citation-identity authority — `Store.getSection` resolves
 *   appendix citations with COLLATE NOCASE, so 'appendix a to part 4' hits
 *   the same row 'Appendix A to Part 4' does;
 * - the kind must match exactly.
 *
 * The REPORTED citation stays the row's verbatim XML `N` (the corpus form);
 * only the MATCH folds case.
 *
 * @param sections The provisions parsed from a document.
 * @param kind The kind of provision wanted.
 * @param citation The citation wanted, in any case.
 * @returns The matching provision, or `undefined` when there is none.
 */
export function findProvision<T extends { readonly kind: string; readonly citation: string }>(
  sections: readonly T[],
  kind: 'section' | 'appendix',
  citation: string,
): T | undefined {
  const wanted = citation.toLowerCase();
  return sections.find(
    (section) => section.kind === kind && section.citation.toLowerCase() === wanted,
  );
}
