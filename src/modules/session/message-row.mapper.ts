import type { IncomingMessage } from '../../engine/interfaces/whatsapp-engine.interface';
import { chatKind } from '../../engine/identity/wa-id';

/**
 * Message types whose rows must show a media placeholder even when the payload carried none.
 *
 * The history sync maps messages media-free to keep its footprint down, so a media-typed message can
 * still reach persistence with no media field at all. Without the marker such a row renders
 * as an empty bubble — the DB copy wins over the engine-history placeholder in the dashboard
 * merge — and the by-type stats filter would skip it. (Neither engine's live path needs synthesis:
 * both emit the omitted marker whenever they have one to build.)
 */
export const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'audio', 'voice', 'sticker', 'document']);

/** The synthesized stand-in for a media payload the engine did not deliver. */
export const OMITTED_MEDIA = { mimetype: '', omitted: true } as const;

/**
 * Builds the `metadata` JSON column for a persisted message row.
 *
 * The three persist paths (live inbound `onMessage`, own-send echo `onMessageCreate`, and the
 * pre-connection history backfill) each assembled this inline, with one deliberate difference:
 * inbound trusts the engine's media field as-is, while the two paths that can arrive without one
 * synthesize a placeholder. Keeping both rules in one function makes that difference explicit
 * instead of something to re-derive at each site.
 *
 * @param synthesizeOmittedMedia When true, a media-typed message with no media payload gets the
 *   omitted marker. False for live inbound, where absent media genuinely means "no media".
 * @returns The metadata object, or undefined when there is nothing to store (the column is nullable
 *   and an empty object would be noise).
 */
export function buildMessageMetadata(
  message: Pick<IncomingMessage, 'media' | 'quotedMessage' | 'call' | 'type'>,
  synthesizeOmittedMedia = false,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (message.media) {
    metadata.media = message.media;
  } else if (synthesizeOmittedMedia && MEDIA_MESSAGE_TYPES.has(message.type)) {
    metadata.media = { ...OMITTED_MEDIA };
  }
  if (message.quotedMessage) {
    metadata.quotedMessage = message.quotedMessage;
  }
  if (message.call) {
    metadata.call = message.call;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/**
 * The `waMessageId` to store for a message.
 *
 * An engine that received a message but could not read its id back reports the empty sentinel, and
 * NULL is what the non-partial `(sessionId, waMessageId)` unique index exempts — storing `''` would
 * collide the second such message and lose the row. Every persist path funnels through here so that
 * chokepoint cannot be forgotten at a new one.
 */
export function storableWaMessageId(id: string | undefined): string | undefined {
  return id || undefined;
}

/**
 * Rebuilds the engine-neutral message an API consumer expects, from a stored row.
 *
 * Used by the store-backed history read, which exists because an engine may be unable to fetch
 * history at all (the evolution-go service has no route for it). The row is what the gateway kept,
 * so this is a lossy reconstruction by nature: the fields the gateway never stored are absent
 * rather than invented, and `kind` is derived from the id rather than read back.
 */
export function rowToIncomingMessage(row: {
  waMessageId?: string | null;
  chatId: string;
  chatName?: string | null;
  author?: string | null;
  from: string;
  to: string;
  body: string;
  type: string;
  direction?: string;
  timestamp: number;
  metadata?: Record<string, unknown> | null;
}): IncomingMessage {
  const metadata = row.metadata ?? {};
  const fromMe = row.direction === 'outgoing';
  const isGroup = row.chatId.endsWith('@g.us');

  const message: IncomingMessage = {
    // A row without an id is still a message the operator can read; an empty string would collide
    // with the next such row downstream, so it degrades to '' only here, at the API edge.
    id: row.waMessageId ?? '',
    chatId: row.chatId,
    from: row.from,
    to: row.to,
    body: row.body,
    type: asMessageType(row.type),
    timestamp: row.timestamp,
    fromMe,
    isGroup,
    kind: chatKind(row.chatId),
    isStatusBroadcast: row.chatId === 'status@broadcast',
  };

  if (row.author) message.author = row.author;
  // The name comes from the row's own column, falling back to the contact block the live path uses
  // so a consumer sees a name for a chat whose rows were written by either writer.
  const chatName = row.chatName ?? undefined;
  if (chatName) message.contact = { id: row.chatId, name: chatName };

  const media = metadata.media as IncomingMessage['media'] | undefined;
  if (media) message.media = media;
  const quoted = metadata.quotedMessage as IncomingMessage['quotedMessage'] | undefined;
  if (quoted) message.quotedMessage = quoted;
  const call = metadata.call as IncomingMessage['call'] | undefined;
  if (call) message.call = call;

  return message;
}

/**
 * Narrows a stored type string to the neutral vocabulary.
 *
 * The column is a plain varchar, so a value written by an older build — or by a future one — must
 * not be handed to consumers as if it were part of the contract. It falls back to `unknown`, which
 * is what that member exists for.
 */
function asMessageType(value: string): IncomingMessage['type'] {
  return KNOWN_MESSAGE_TYPES.has(value) ? (value as IncomingMessage['type']) : 'unknown';
}

const KNOWN_MESSAGE_TYPES = new Set<string>([
  'text',
  'image',
  'video',
  'audio',
  'voice',
  'document',
  'sticker',
  'location',
  'contact',
  'poll',
  'call',
  'revoked',
  'order',
  'product',
  'masked',
  'unknown',
]);
