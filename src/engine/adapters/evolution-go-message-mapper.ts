/**
 * Maps an Evolution Go webhook payload into the engine-neutral {@link IncomingMessage}.
 *
 * This is the anti-corruption layer for the evolution-go engine, and it has one job the library
 * engines do not: the payload crosses a JSON boundary between two independently versioned programs,
 * so the field names are not guaranteed by a type. Two concrete hazards, both handled here rather
 * than at each call site:
 *
 *  1. **Casing.** The service's REST responses carry lowerCamelCase json tags, while the webhook
 *     marshals the same structs with Go's default field names (PascalCase) — the TurboZap backend
 *     reads `Info.IsFromMe`/`Info.Chat`/`Info.ID` off its own webhook receiver and lowerCamel off
 *     the REST client for the same structs. Reading only one spelling makes the mapper return
 *     nothing, silently, on the deployment that uses the other. Every field is therefore read
 *     through {@link pick}, which accepts either.
 *  2. **JID dialect.** The service speaks `@s.whatsapp.net` and `@lid` with device suffixes.
 *     IWhatsAppEngine's contract is the neutral dialect, so every id is normalised on the way out.
 */

import { chatKind, toNeutralJid, type ChatKind } from '../identity/wa-id';
import type { IncomingMessage, MessageType } from '../interfaces/whatsapp-engine.interface';

/** A JSON object with unknown values, as received. */
type Json = Record<string, unknown>;

function asObject(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (typeof value === 'number') return String(value);
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/** An array view of a loosely-typed field; anything else reads as empty rather than throwing. */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * First present value among `keys`, so a field can be read under either JSON convention.
 *
 * Order matters for fields the service emits in both spellings with different meanings — none
 * currently — so callers list the spelling they trust most first.
 */
export function pick(source: Json | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) return source[key];
  }
  return undefined;
}

export function pickString(source: Json | undefined, ...keys: string[]): string | undefined {
  return asString(pick(source, ...keys));
}

function pickBoolean(source: Json | undefined, ...keys: string[]): boolean | undefined {
  return asBoolean(pick(source, ...keys));
}

/**
 * Unix SECONDS from whichever shape the service used.
 *
 * Go marshals `time.Time` as RFC3339, and whatsmeow's own info struct carries a `time.Time`, so
 * both an ISO string and a bare unix number are plausible here. A numeric value is disambiguated by
 * magnitude: anything past 1e12 cannot be seconds (that would be the year 33658), so it is
 * milliseconds. Falling back to "now" keeps a malformed timestamp from dropping the message.
 */
export function parseTimestamp(value: unknown): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (typeof value === 'string' && value.length > 0) {
    if (/^\d+$/.test(value)) {
      const numeric = Number(value);
      return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return nowSeconds;
}

/** The message body node, e.g. `conversation`, `imageMessage`, `extendedTextMessage`. */
export interface ParsedContent {
  type: MessageType;
  body: string;
  mimetype?: string;
  filename?: string;
  /** True for a voice note rather than a file of audio. */
  ptt?: boolean;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  locationAddress?: string;
  /** Poll question, when this is a poll. */
  pollName?: string;
  /** Quoted message id, when this message replies to another. */
  quotedId?: string;
  /** Neutral WIDs @mentioned in the message. */
  mentionedIds?: string[];
  /** Base64 payload, when the service inlined one. */
  inlineBase64?: string;
}

/** Fields of a node like `imageMessage` that every media node shares. */
function readContextInfo(node: Json | undefined): { quotedId?: string; mentionedIds?: string[] } {
  const contextInfo = asObject(pick(node, 'contextInfo', 'ContextInfo'));
  if (!contextInfo) return {};
  const quotedId = pickString(contextInfo, 'stanzaId', 'StanzaID', 'StanzaId');
  const mentioned = pick(contextInfo, 'mentionedJid', 'mentionedJID', 'MentionedJID');
  const mentionedIds = Array.isArray(mentioned)
    ? mentioned.map(entry => asString(entry)).filter((entry): entry is string => entry !== undefined)
    : undefined;
  return { quotedId, mentionedIds };
}

function mediaNode(
  node: Json | undefined,
  defaultMimetype?: string,
): { mimetype?: string; filename?: string; base64?: string } {
  return {
    mimetype: pickString(node, 'mimetype', 'Mimetype') ?? defaultMimetype,
    filename: pickString(node, 'fileName', 'FileName', 'filename'),
    base64: pickString(node, 'base64', 'Base64', 'data', 'Data'),
  };
}

/**
 * Classifies the message body node and extracts what the neutral contract carries.
 *
 * Ordered by specificity: a poll and an edited message also look like generic nodes, so the
 * distinguishing key is checked before the fallbacks.
 */
export function parseContent(message: Json | undefined): ParsedContent {
  if (!message) return { type: 'unknown', body: '' };

  // A view-once or ephemeral wrapper hides the real node one level down.
  const wrapped = asObject(pick(message, 'viewOnceMessage', 'viewOnceMessageV2', 'ephemeralMessage'));
  if (wrapped) {
    const inner = asObject(pick(wrapped, 'message', 'Message'));
    if (inner) return parseContent(inner);
  }

  const conversation = pickString(message, 'conversation', 'Conversation');
  if (conversation !== undefined) {
    return { type: 'text', body: conversation };
  }

  const extended = asObject(pick(message, 'extendedTextMessage', 'ExtendedTextMessage'));
  if (extended) {
    return {
      type: 'text',
      body: pickString(extended, 'text', 'Text') ?? '',
      ...readContextInfo(extended),
    };
  }

  const image = asObject(pick(message, 'imageMessage', 'ImageMessage'));
  if (image) {
    return {
      type: 'image',
      body: pickString(image, 'caption', 'Caption') ?? '',
      ...readContextInfo(image),
      ...mediaNode(image),
    };
  }

  const video = asObject(pick(message, 'videoMessage', 'VideoMessage'));
  if (video) {
    return {
      type: 'video',
      body: pickString(video, 'caption', 'Caption') ?? '',
      ...readContextInfo(video),
      ...mediaNode(video),
    };
  }

  // Voice notes arrive as their own node on some builds and as `audioMessage` with `ptt` on
  // others, so both are checked and the flag is derived from either.
  const ptt = asObject(pick(message, 'pttMessage', 'PttMessage'));
  const audio = ptt ?? asObject(pick(message, 'audioMessage', 'AudioMessage'));
  if (audio) {
    const media = mediaNode(audio, 'audio/ogg');
    return {
      type: ptt ? 'voice' : pickBoolean(audio, 'ptt', 'PTT') ? 'voice' : 'audio',
      body: '',
      ...readContextInfo(audio),
      ...media,
      ptt: ptt !== undefined || pickBoolean(audio, 'ptt', 'PTT') === true,
    };
  }

  const document = asObject(pick(message, 'documentMessage', 'DocumentMessage'));
  if (document) {
    return {
      type: 'document',
      body: pickString(document, 'caption', 'Caption') ?? '',
      ...readContextInfo(document),
      ...mediaNode(document),
    };
  }

  const sticker = asObject(pick(message, 'stickerMessage', 'StickerMessage'));
  if (sticker) {
    return {
      type: 'sticker',
      body: '',
      ...readContextInfo(sticker),
      ...mediaNode(sticker, 'image/webp'),
    };
  }

  const location = asObject(pick(message, 'locationMessage', 'LocationMessage'));
  if (location) {
    return {
      type: 'location',
      body: '',
      latitude: Number(pick(location, 'degreesLatitude', 'DegreesLatitude') ?? NaN),
      longitude: Number(pick(location, 'degreesLongitude', 'DegreesLongitude') ?? NaN),
      locationName: pickString(location, 'name', 'Name'),
      locationAddress: pickString(location, 'address', 'Address'),
    };
  }

  if (pick(message, 'contactMessage', 'ContactMessage', 'contactsArrayMessage', 'ContactsArrayMessage')) {
    return { type: 'contact', body: '' };
  }

  const poll = asObject(
    pick(message, 'pollCreationMessage', 'PollCreationMessage', 'pollCreationMessageV3', 'PollCreationMessageV3'),
  );
  if (poll) {
    return { type: 'poll', body: pickString(poll, 'name', 'Name') ?? '', pollName: pickString(poll, 'name', 'Name') };
  }

  if (pick(message, 'protocolMessage', 'ProtocolMessage')) {
    return { type: 'revoked', body: '' };
  }

  if (pick(message, 'reactionMessage', 'ReactionMessage')) {
    return { type: 'unknown', body: '' };
  }

  return { type: 'unknown', body: '' };
}

export interface MapMessageOptions {
  /** Resolves a lid to a phone when the mapping is known; forwarded to the id normaliser. */
  resolvePhone?: (jid: string) => string | null;
}

export interface MappedMessage extends IncomingMessage {
  /** The raw body node, kept for the event mapper's protocol/reaction handling. */
  rawContent: Json | undefined;
  /** Raw `Info` node, so callers can read fields the neutral shape does not carry. */
  rawInfo: Json | undefined;
}

/**
 * Maps one webhook message into the neutral shape.
 *
 * Returns `null` when the payload carries no identifying info at all — a message without an id or a
 * chat cannot be stored, dispatched or deduplicated, so inventing one would corrupt the message
 * table rather than lose a single event.
 */
export function mapIncomingMessage(data: Json, options: MapMessageOptions = {}): MappedMessage | null {
  const info = asObject(pick(data, 'Info', 'info'));
  const content = asObject(pick(data, 'Message', 'message'));

  const id = pickString(info, 'ID', 'id');
  const chatRaw = pickString(info, 'Chat', 'chat');
  if (!id || !chatRaw) return null;

  const resolvePhone = options.resolvePhone;
  const chatId = toNeutralJid(chatRaw, resolvePhone);
  const fromMe = pickBoolean(info, 'IsFromMe', 'isFromMe') ?? false;
  const isGroup = pickBoolean(info, 'IsGroup', 'isGroup') ?? chatId.endsWith('@g.us');

  const senderRaw = pickString(info, 'Sender', 'sender', 'SenderAlt', 'senderAlt') ?? chatRaw;
  const authorId = toNeutralJid(senderRaw, resolvePhone);

  // A group message's `from` is the GROUP; the sender rides on `author`. Outside a group, `from` is
  // the counterparty and `to` is us (or the reverse, when we sent it) — the neutral contract states
  // this orientation explicitly, and consumers branch on it.
  const from = isGroup ? chatId : fromMe ? chatId : authorId;
  const to = isGroup ? authorId : fromMe ? authorId : chatId;

  const parsed = parseContent(content);
  const pushName = pickString(data, 'PushName', 'pushName') ?? pickString(info, 'PushName', 'pushName');

  const mentioned = parsed.mentionedIds?.map(entry => toNeutralJid(entry, resolvePhone));
  const quotedId = parsed.quotedId ? toNeutralJid(parsed.quotedId, resolvePhone) : undefined;

  const kind: ChatKind = chatKind(chatId);

  const message: MappedMessage = {
    id,
    from,
    to,
    chatId,
    body: parsed.body,
    type: parsed.type,
    timestamp: parseTimestamp(pick(info, 'Timestamp', 'timestamp')),
    fromMe,
    isGroup,
    kind,
    isStatusBroadcast: chatId === 'status@broadcast',
    author: isGroup ? authorId : undefined,
    mentionedIds: mentioned && mentioned.length > 0 ? mentioned : undefined,
    rawContent: content,
    rawInfo: info,
  };

  if (pushName) {
    message.contact = { id: authorId, pushName };
  }

  if (parsed.type === 'location' && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
    message.location = {
      latitude: parsed.latitude as number,
      longitude: parsed.longitude as number,
      description: parsed.locationName,
      address: parsed.locationAddress,
    };
  }

  if (parsed.inlineBase64) {
    message.media = {
      mimetype: parsed.mimetype ?? 'application/octet-stream',
      filename: parsed.filename,
      data: parsed.inlineBase64,
    };
  } else if (parsed.type !== 'text' && parsed.type !== 'location' && parsed.type !== 'unknown') {
    // The service inlines media only sometimes (its own receiver documents an audio arriving with no
    // base64 at all), so the absence is recorded as an omission the caller can fill from
    // /message/downloadmedia rather than as an empty payload that reads like a zero-byte file.
    message.media = { mimetype: parsed.mimetype ?? 'application/octet-stream', omitted: true };
  }

  if (quotedId) {
    message.quotedMessage = { id: quotedId, body: '' };
  }

  return message;
}

/** One chat's worth of history, as the sync reports it. */
export interface MappedHistoryBatch {
  /** Historical messages, in the neutral shape the persistence path expects. */
  messages: MappedMessage[];
  /**
   * Display names the sync disclosed, keyed by NEUTRAL chat id.
   *
   * History conversations carry the chat's name, which the message rows do not otherwise have — a
   * backfilled row would show its raw id in the chat list without this.
   */
  chatNames: Record<string, string>;
  /** How far along the sync is, 0-100, when the service reports it. */
  progress?: number;
}

/**
 * Maps a HistorySync event into the neutral shape.
 *
 * This is the ONLY source of pre-connection history for this engine, and the service pushes it once
 * per newly linked device. Everything about the parsing is therefore defensive: a field this fails to
 * read is history that never reaches the chat list again.
 *
 * The payload nests several levels deep and mixes two JSON conventions — the wrappers are Go structs
 * without tags (PascalCase) while the protobuf bodies carry generated json tags (camelCase) — so each
 * level is read under both spellings. Timestamps are protobuf uint64, which serialise to a STRING.
 */
export function mapHistorySync(data: Json, options: MapMessageOptions = {}): MappedHistoryBatch {
  const batch: MappedHistoryBatch = { messages: [], chatNames: {} };

  const payload = asObject(pick(data, 'Data', 'data')) ?? data;
  const conversations = asArray(pick(payload, 'conversations', 'Conversations'));
  if (conversations.length === 0) return batch;

  const progressValue = pick(payload, 'progress', 'Progress');
  if (typeof progressValue === 'number') batch.progress = progressValue;

  const resolvePhone = options.resolvePhone;

  for (const rawConversation of conversations) {
    const conversation = asObject(rawConversation);
    if (!conversation) continue;

    const chatRaw = pickString(conversation, 'id', 'ID', 'jid', 'JID');
    if (!chatRaw) continue;
    const chatId = toNeutralJid(chatRaw, resolvePhone);
    const isGroup = chatId.endsWith('@g.us');

    const chatName = pickString(conversation, 'name', 'Name');
    if (chatName) batch.chatNames[chatId] = chatName;

    for (const rawEntry of asArray(pick(conversation, 'messages', 'Messages'))) {
      const entry = asObject(rawEntry);
      if (!entry) continue;

      // The entry wraps the message under `message`; some builds put it at the top level instead.
      const info = asObject(pick(entry, 'message', 'Message')) ?? entry;

      const key = asObject(pick(info, 'key', 'Key'));
      const id = pickString(key, 'id', 'ID');
      if (!id) continue;

      const content = asObject(pick(info, 'message', 'Message'));
      if (!content) continue;

      const fromMe = pickBoolean(key, 'fromMe', 'FromMe') ?? false;
      const senderRaw =
        pickString(key, 'participant', 'Participant') ?? pickString(key, 'remoteJid', 'remoteJid', 'RemoteJid');
      const authorId = toNeutralJid(senderRaw ?? chatRaw, resolvePhone);

      // The same orientation the live path uses: in a group the message belongs to the GROUP and the
      // sender rides on `author`; outside one, from/to are us and the counterparty.
      const from = isGroup ? chatId : fromMe ? chatId : authorId;
      const to = isGroup ? authorId : fromMe ? authorId : chatId;

      const parsed = parseContent(content);
      const pushName = pickString(info, 'pushName', 'PushName');

      const message: MappedMessage = {
        id,
        from,
        to,
        chatId,
        body: parsed.body,
        type: parsed.type,
        timestamp: parseTimestamp(pick(info, 'messageTimestamp', 'MessageTimestamp')),
        fromMe,
        isGroup,
        kind: chatKind(chatId),
        isStatusBroadcast: chatId === 'status@broadcast',
        author: isGroup ? authorId : undefined,
        mentionedIds: parsed.mentionedIds?.map(entryId => toNeutralJid(entryId, resolvePhone)),
        rawContent: content,
        rawInfo: info,
      };

      // History carries descriptors, not payloads: downloading media for a bulk sync would mean one
      // round trip per message, which is exactly what a backfill must not do. An omission is
      // recorded rather than left absent, so a consumer can tell "not fetched" from "there was none".
      if (parsed.inlineBase64) {
        message.media = {
          mimetype: parsed.mimetype ?? 'application/octet-stream',
          filename: parsed.filename,
          data: parsed.inlineBase64,
        };
      } else if (parsed.type !== 'text' && parsed.type !== 'location' && parsed.type !== 'unknown') {
        message.media = { mimetype: parsed.mimetype ?? 'application/octet-stream', omitted: true };
      }

      // pushName is the sender's own display name and wins; the conversation's name is the
      // fallback, and it is often the only name a history row has (a saved contact whose owner never
      // set a push name). Carried on `contact` because that is where the persistence path reads a
      // chat's name from, in both the live and the history writers.
      if (pushName || chatName) {
        message.contact = { id: authorId, pushName, name: chatName };
      }

      if (parsed.type === 'location' && Number.isFinite(parsed.latitude) && Number.isFinite(parsed.longitude)) {
        message.location = {
          latitude: parsed.latitude as number,
          longitude: parsed.longitude as number,
          description: parsed.locationName,
          address: parsed.locationAddress,
        };
      }

      batch.messages.push(message);
    }
  }

  return batch;
}
