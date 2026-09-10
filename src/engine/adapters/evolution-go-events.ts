/**
 * Turns Evolution Go webhook payloads into the engine's neutral {@link EngineEventCallbacks}.
 *
 * Every branch decides one thing: which callback a remote event becomes. The mapping is kept out of
 * the adapter so the adapter stays a transport-facing object, and out of the controller so the
 * controller stays a router.
 *
 * Two rules the branches follow deliberately:
 *
 *  1. **Sub-events are not new messages.** A revoke, an edit and a reaction all arrive inside a
 *     `Message` event. Dispatching them as inbound messages as well would deliver an edit as a
 *     second copy of the text and a revoke as an empty message, so each is routed to its own
 *     callback and never to `onMessage`.
 *  2. **An unhandled event is dropped silently, on purpose.** The service emits a high-volume stream
 *     of events this gateway has no consumer for; logging each one would bury the ones that matter.
 */

import type { CallOutcome, DeliveryStatus } from '../interfaces/whatsapp-engine.interface';
import type { EvolutionGoAdapter } from './evolution-go.adapter';
import { mapHistorySync } from './evolution-go-message-mapper';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pick(source: Json | undefined, ...keys: string[]): unknown {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickString(source: Json | undefined, ...keys: string[]): string | undefined {
  const value = pick(source, ...keys);
  return typeof value === 'string' && value.length > 0 ? value : typeof value === 'number' ? String(value) : undefined;
}

function pickNumber(source: Json | undefined, ...keys: string[]): number | undefined {
  const value = pick(source, ...keys);
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : undefined;
}

/**
 * Maps the service's delivery-status vocabulary onto the neutral one.
 *
 * The service reports WhatsApp's own numeric receipt codes; the neutral set is coarser. An
 * unrecognised code maps to `sent` rather than being dropped: the message demonstrably left the
 * gateway, and reporting nothing would leave a consumer's optimistic state stuck on `pending`.
 */
export function mapDeliveryStatus(raw: unknown): DeliveryStatus {
  const value = typeof raw === 'string' ? raw.toUpperCase() : raw;
  switch (value) {
    case 'PENDING':
    case 0:
      return 'pending';
    case 'SERVER_ACK':
    case 'SENT':
    case 1:
      return 'sent';
    case 'DELIVERY_ACK':
    case 'DELIVERED':
    case 2:
      return 'delivered';
    case 'READ':
    case 'PLAYED':
    case 3:
    case 4:
      return 'read';
    case 'ERROR':
    case 'FAILED':
      return 'failed';
    default:
      return 'sent';
  }
}

/** Delivery receipts ride on the message event as `MessageStatus`/`Status` rather than a receipt node. */
function handleReceipt(adapter: EvolutionGoAdapter, data: Json): boolean {
  const info = asRecord(pick(data, 'Info', 'info'));
  const id = pickString(info, 'ID', 'id');
  const status = pick(info, 'Status', 'status', 'MessageStatus', 'messageStatus', 'Receipt', 'receipt');
  if (!id || status === undefined) return false;
  adapter.emitAck(id, mapDeliveryStatus(status));
  return true;
}

/**
 * A standalone `Receipt` event: WhatsApp advancing one or more messages' delivery state.
 *
 * This is a DIFFERENT shape from the receipt embedded in a message event, and the distinction
 * matters — the embedded one carries `Info.ID`, this one carries a `MessageIDs` ARRAY plus a
 * `Type` that names the transition. Reading one with the other's field names yields nothing, which
 * is why a send would sit at "sent" forever with no error anywhere.
 *
 * whatsmeow's vocabulary is the wire's: a `delivered` receipt is the recipient's device
 * acknowledging, and `read` (or `played`, for a voice note) is the blue tick.
 */
function handleReceiptEvent(adapter: EvolutionGoAdapter, data: Json): boolean {
  const ids = asArray(pick(data, 'MessageIDs', 'MessageIds', 'messageIds', 'ids'))
    .map(entry => (typeof entry === 'string' ? entry : undefined))
    .filter((entry): entry is string => entry !== undefined);
  if (ids.length === 0) return false;

  const status = mapDeliveryStatus(pick(data, 'Type', 'type'));
  for (const id of ids) adapter.emitAck(id, status);
  return true;
}

/** The counterparty's typing/recording indicator, reported per chat. */
function handleChatPresence(adapter: EvolutionGoAdapter, data: Json): void {
  const chatId = pickString(data, 'Chat', 'chat', 'jid', 'JID');
  if (!chatId) return;
  const rawState = (pickString(data, 'State', 'state', 'type', 'Type') ?? '').toLowerCase();
  const isAudio = pick(data, 'IsAudio', 'isAudio', 'media', 'Media') === true || rawState === 'audio';

  // The wire says "composing" and uses a media flag for audio, while the neutral vocabulary has a
  // distinct `recording` state — so the flag decides the word rather than a separate token.
  const state = rawState === 'paused' ? 'paused' : isAudio ? 'recording' : 'composing';
  adapter.emitPresence(chatId, state, pickString(data, 'Sender', 'sender') ?? chatId);
}

function handleGroup(adapter: EvolutionGoAdapter, data: Json): void {
  const rawId = pickString(data, 'JID', 'jid', 'groupJid', 'GroupJID', 'id', 'ID');
  if (!rawId) return;
  const action = (pickString(data, 'type', 'Type', 'action', 'Action') ?? '').toLowerCase();
  const participants = asArray(pick(data, 'Participants', 'participants', 'participantIds'))
    .map(entry => (typeof entry === 'string' ? entry : pickString(asRecord(entry), 'JID', 'jid', 'id', 'ID')))
    .filter((entry): entry is string => entry !== undefined);

  // A group event with no recognisable action is an UPDATE (subject/description/settings), because
  // that is what the service sends without a membership verb on it.
  const kind =
    action.includes('join') && !action.includes('request')
      ? 'join'
      : action.includes('leave') || action.includes('remove')
        ? 'leave'
        : action.includes('request')
          ? 'join_request'
          : 'update';

  adapter.emitGroupEvent({
    kind,
    groupId: rawId,
    actorId: pickString(data, 'Author', 'author', 'Sender', 'sender'),
    participantIds: participants,
    timestamp: pickNumber(data, 'Timestamp', 'timestamp') ?? Math.floor(Date.now() / 1000),
  });
}

function handleCall(adapter: EvolutionGoAdapter, data: Json): void {
  const callId = pickString(data, 'callId', 'CallID', 'id', 'ID');
  if (!callId) return;
  const rawState = (pickString(data, 'state', 'State', 'status', 'Status') ?? '').toLowerCase();
  const from = pickString(data, 'from', 'From', 'caller', 'Caller') ?? '';
  const isVideo = pick(data, 'isVideo', 'IsVideo', 'video', 'Video') === true;

  // A ringing call and its outcome are separate callbacks: re-entering the ring path with an outcome
  // would make a declined call look like a fresh incoming one (and be auto-rejected twice).
  if (rawState === 'offer' || rawState === 'ringing' || rawState === 'incoming' || rawState === '') {
    adapter.emitCall({ callId, from, isVideo, isGroup: false, timestamp: Math.floor(Date.now() / 1000) });
    return;
  }
  const outcome: CallOutcome = rawState.includes('accept')
    ? 'accepted'
    : rawState.includes('reject') || rawState.includes('declin')
      ? 'rejected'
      : 'missed';
  adapter.emitCallOutcome({ callId, from, outcome, isVideo, isGroup: false, timestamp: Math.floor(Date.now() / 1000) });
}

/**
 * Routes one webhook payload.
 *
 * Returns `true` when the event was recognised. The controller uses that only for logging, never to
 * decide whether to answer 200 — a webhook the service considers failed is retried, and retrying an
 * event we deliberately ignore would loop forever.
 */
export function dispatchRemoteEvent(adapter: EvolutionGoAdapter, event: string, payload: Json): boolean {
  const data = asRecord(pick(payload, 'data', 'Data')) ?? payload;

  switch (event) {
    case 'QRCode':
    case 'QrCode':
    case 'qrcode':
      adapter.handleRemoteEvent('QRCode', data);
      return true;

    // Connection state. The service does NOT emit an event called "Connection": it emits the
    // transitions themselves, so each is recognised and folded onto the one adapter entry point.
    // Matching only the guessed name would leave a session that connected perfectly reporting
    // INITIALIZING forever.
    case 'Connection':
    case 'connection.update':
      adapter.handleRemoteEvent('Connection', data);
      return true;

    case 'Connected':
      // Payload: { status: "open", jid, pushName }.
      adapter.handleRemoteEvent('Connection', { ...data, state: pickString(data, 'status', 'Status') ?? 'open' });
      return true;

    case 'Disconnected':
    case 'ConnectFailure':
      adapter.handleRemoteEvent('Connection', { ...data, state: 'close' });
      return true;

    case 'LoggedOut':
      // Terminal and distinct from a drop: the account is unlinked, so no reconnect can succeed.
      adapter.emitLoggedOut(pickString(data, 'reason', 'Reason') ?? 'logged out');
      return true;

    case 'TemporaryBan':
      // WhatsApp's own restriction notice — the one signal that explains a session which is
      // connected but silently cannot reach anyone.
      adapter.emitRestriction({
        kind: 'reachout_timelock',
        code: pickString(data, 'reason', 'Reason') ?? 'temporary_ban',
        expiresAt: pickNumber(data, 'expire', 'Expire'),
      });
      return true;

    case 'HistorySync':
      // The only source of pre-connection history for this engine. Routed to the history-specific
      // callback rather than the live one, because these messages predate the session.
      adapter.emitHistory(mapHistorySync(asRecord(pick(payload, 'data', 'Data')) ?? payload));
      return true;

    case 'QRTimeout':
      // The displayed code expired without being scanned. NOT a failure: the engine has been
      // re-issuing codes all along and only gives up after a couple of minutes (at which point it
      // emits LoggedOut). Marking the session failed here would report a problem while the pairing
      // window is still open, so this only clears the stale code and keeps waiting.
      adapter.handleQrTimeout();
      return true;

    case 'PairSuccess':
      adapter.handleRemoteEvent('Connection', { ...data, state: 'open' });
      return true;

    case 'Message':
    case 'message':
    case 'messages.upsert': {
      // Receipts first: they carry an `Info` too, and treating one as an inbound message would
      // deliver a status update as an empty message from the recipient.
      if (handleReceipt(adapter, data)) return true;
      adapter.emitInbound(data);
      return true;
    }

    case 'SendMessage':
    case 'SEND_MESSAGE':
      adapter.emitInbound(data);
      return true;

    case 'Receipt':
    case 'READ_RECEIPT':
      // Delivery/read transitions. Without these an outgoing message never advances past "sent",
      // because nothing else in this engine's surface reports them.
      return handleReceiptEvent(adapter, data);

    case 'ChatPresence':
      // The other party typing or recording. The service reports it per chat, and it is what makes
      // a chat view show "digitando…" for the person on the other side.
      handleChatPresence(adapter, data);
      return true;

    case 'Group':
    case 'group':
      handleGroup(adapter, data);
      return true;

    case 'Call':
    case 'call':
      handleCall(adapter, data);
      return true;

    case 'Presence':
    case 'presence': {
      const chatId = pickString(data, 'chat', 'Chat', 'id', 'ID');
      const state = pickString(data, 'state', 'State', 'presence', 'Presence');
      if (chatId && state) {
        adapter.emitPresence(
          chatId,
          state.toLowerCase() as 'available',
          pickString(data, 'sender', 'Sender') ?? chatId,
        );
      }
      return true;
    }

    default:
      return false;
  }
}
