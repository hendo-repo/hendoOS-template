/**
 * Document rendering — one content document to one payload segment.
 *
 * The rendered shape is deliberately fixed and byte-stable:
 *
 * ```
 * <!-- aos:content id=<id> v=<version> tier=<tier> bytes=<bytes> -->
 * <body>
 * ```
 *
 * Rules:
 * - The header is a single line with no trailing content; fields are space-separated
 *   `key=value` in the order `id`, `v`, `tier`, `bytes`.
 * - Exactly one `\n` follows the header, and none is inserted after the body — the
 *   caller owns inter-segment separation. This makes the payload a pure concatenation
 *   of segment texts and keeps a scenario's activated-kernel prefix byte-stable.
 * - `bytes` is the UTF-8 byte length of the *body* (not of the header, not of the
 *   source document) — the number a per-entry budget check compares against.
 * - No source path, no host path, no identity, no timestamp, no ordering counter
 *   appears in the rendered text: the output is a pure function of the document.
 */
import type { ContentDocument } from '../schema/content';
import { byteLength } from '../protocols/text';

export interface RenderedDocument {
  id: string;
  version: number;
  tier: ContentDocument['tier'];
  /** UTF-8 bytes of the body. */
  bytes: number;
  /** Body verbatim — also the segment text's body portion. */
  body: string;
  /** Full rendered text (header line + body). */
  text: string;
}

export function renderDocumentHeader(document: Pick<ContentDocument, 'id' | 'version' | 'tier'> & { body: string }): string {
  return `<!-- aos:content id=${document.id} v=${document.version} tier=${document.tier} bytes=${byteLength(document.body)} -->`;
}

/** Render one document to a segment-ready payload. Pure. */
export function renderDocument(document: ContentDocument): RenderedDocument {
  const body = document.body;
  const bytes = byteLength(body);
  return {
    id: document.id,
    version: document.version,
    tier: document.tier,
    bytes,
    body,
    text: `${renderDocumentHeader(document)}\n${body}`,
  };
}

/** Render a framework-owned static block that has no content document. Pure. */
export function renderStaticBlock(id: string, text: string): RenderedDocument {
  return {
    id,
    version: 0,
    tier: 'kernel',
    bytes: byteLength(text),
    body: text,
    text,
  };
}
