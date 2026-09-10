/**
 * Behaviour tests for the Evolution Go webhook `dispatchRemoteEvent` router.
 *
 * This module had no test at all until the delivery-receipt bug below, which is precisely why the bug
 * survived a working deployment: every layer looked healthy. The service accepted the send, the route
 * answered 200, the engine logged "Message delivered", and the stored row stayed at `sent` forever.
 *
 * The first fixture is not invented — it is a payload captured verbatim off the wire (via a tap that
 * logged and forwarded the webhook), which is the only way the empty `data.Type` was ever going to
 * show up. `state` rides on the ENVELOPE, outside `data`, and no amount of reading the documented
 * inner field reveals that.
 */

import { dispatchRemoteEvent } from './evolution-go-events';
import type { EvolutionGoAdapter } from './evolution-go.adapter';
import type { DeliveryStatus } from '../interfaces/whatsapp-engine.interface';

/** The callbacks the router may reach, all inert. */
function fakeAdapter() {
  return {
    // Typed, so the assertions read the neutral status vocabulary rather than `any`.
    emitAck: jest.fn<void, [string, DeliveryStatus]>(),
    emitInbound: jest.fn(),
    emitHistory: jest.fn(),
    emitPresence: jest.fn(),
    emitCall: jest.fn(),
    emitCallOutcome: jest.fn(),
    emitLoggedOut: jest.fn(),
    emitRestriction: jest.fn(),
    handleRemoteEvent: jest.fn(),
    handleQrTimeout: jest.fn(),
  };
}

type Fake = ReturnType<typeof fakeAdapter>;

function asEngine(fake: Fake): EvolutionGoAdapter {
  return fake as unknown as EvolutionGoAdapter;
}

/**
 * Captured from a live 0.7.2 deployment when the recipient's device acknowledged a send.
 *
 * Note `Type: ''` — present, empty, and the reason a reader that trusts it emits `sent` for a message
 * that is already `sent`. The transition is in the envelope's `state`.
 */
const CAPTURED_DELIVERED_RECEIPT: Record<string, unknown> = {
  data: {
    Chat: '117836940882060@lid',
    Sender: '117836940882060@lid',
    IsFromMe: false,
    IsGroup: false,
    AddressingMode: '',
    SenderAlt: '',
    RecipientAlt: '',
    BroadcastListOwner: '',
    BroadcastRecipients: null,
    MessageIDs: ['3EB08DF5CC87651BE51DD5'],
    Timestamp: '2026-09-10T19:46:53-03:00',
    Type: '',
    MessageSender: '',
  },
  event: 'Receipt',
  instanceId: '7e4223f3-c545-48b6-b457-231e2eb066a1',
  instanceName: 'openwa-teste-evo',
  instanceToken: '75e5dd22-50ab-4ac8-b5a8-5bff4cf3097c',
  state: 'Delivered',
};

describe('dispatchRemoteEvent — Receipt', () => {
  let fake: Fake;

  beforeEach(() => {
    fake = fakeAdapter();
  });

  it('advances a delivery receipt from the envelope state, not the empty inner Type', () => {
    const handled = dispatchRemoteEvent(asEngine(fake), 'Receipt', CAPTURED_DELIVERED_RECEIPT);

    expect(handled).toBe(true);
    // The regression: reading `data.Type` alone yields '', which maps to the default 'sent' and
    // silently no-ops against a message that is already 'sent'.
    expect(fake.emitAck).toHaveBeenCalledWith('3EB08DF5CC87651BE51DD5', 'delivered');
  });

  it('treats the service READ_RECEIPT alias identically', () => {
    dispatchRemoteEvent(asEngine(fake), 'READ_RECEIPT', CAPTURED_DELIVERED_RECEIPT);
    expect(fake.emitAck).toHaveBeenCalledWith('3EB08DF5CC87651BE51DD5', 'delivered');
  });

  it.each([
    ['Read', 'read'],
    ['Played', 'read'],
    ['Delivered', 'delivered'],
  ])('maps envelope state %s to %s', (state, expected) => {
    dispatchRemoteEvent(asEngine(fake), 'Receipt', { data: { MessageIDs: ['M1'] }, event: 'Receipt', state });
    expect(fake.emitAck).toHaveBeenCalledWith('M1', expected);
  });

  it('prefers a populated inner Type over the envelope state', () => {
    // A future version (or a message-embedded receipt) that fills `Type` must win: it is the
    // documented field and the more specific one.
    dispatchRemoteEvent(asEngine(fake), 'Receipt', {
      data: { MessageIDs: ['M1'], Type: 'READ' },
      event: 'Receipt',
      state: 'Delivered',
    });
    expect(fake.emitAck).toHaveBeenCalledWith('M1', 'read');
  });

  it('acks every id in a batched receipt', () => {
    dispatchRemoteEvent(asEngine(fake), 'Receipt', {
      data: { MessageIDs: ['M1', 'M2', 'M3'] },
      event: 'Receipt',
      state: 'Read',
    });
    expect(fake.emitAck).toHaveBeenCalledTimes(3);
    expect(fake.emitAck.mock.calls.map(call => call[0])).toEqual(['M1', 'M2', 'M3']);
  });

  it('reports a receipt with no ids as unhandled rather than acking nothing', () => {
    const handled = dispatchRemoteEvent(asEngine(fake), 'Receipt', {
      data: { MessageIDs: [] },
      event: 'Receipt',
      state: 'Delivered',
    });
    expect(handled).toBe(false);
    expect(fake.emitAck).not.toHaveBeenCalled();
  });

  it('never delivers a receipt as an inbound message', () => {
    // A receipt carries no content; routing it to onMessage delivers an empty message from the
    // recipient, which is how a chat view fills up with blank bubbles.
    dispatchRemoteEvent(asEngine(fake), 'Receipt', CAPTURED_DELIVERED_RECEIPT);
    expect(fake.emitInbound).not.toHaveBeenCalled();
  });

  it('still emits the documented default when neither field names a transition', () => {
    // Unrecognisable, so the coarsest true statement is that it left the gateway.
    dispatchRemoteEvent(asEngine(fake), 'Receipt', { data: { MessageIDs: ['M1'] }, event: 'Receipt' });
    expect(fake.emitAck).toHaveBeenCalledWith('M1', 'sent');
  });
});

describe('dispatchRemoteEvent — Message', () => {
  let fake: Fake;

  beforeEach(() => {
    fake = fakeAdapter();
  });

  it('routes a receipt embedded in a message event to onMessageAck, not onMessage', () => {
    const handled = dispatchRemoteEvent(asEngine(fake), 'Message', {
      data: { Info: { ID: 'OUT1', Status: 'DELIVERED' } },
      event: 'Message',
    });

    expect(handled).toBe(true);
    expect(fake.emitAck).toHaveBeenCalledWith('OUT1', 'delivered');
    expect(fake.emitInbound).not.toHaveBeenCalled();
  });

  it('still delivers a real inbound message', () => {
    const payload = {
      data: { Info: { ID: 'IN1', Chat: '5527998400341@s.whatsapp.net' }, Message: { conversation: 'oi' } },
      event: 'Message',
    };

    expect(dispatchRemoteEvent(asEngine(fake), 'Message', payload)).toBe(true);
    expect(fake.emitInbound).toHaveBeenCalledWith(payload.data);
  });

  it('reports a Message event as handled even when its payload carries nothing mappable', () => {
    // Recognition and mapping are deliberately separate: this router answers "a Message event
    // arrived", and `emitInbound`'s own mapper is what drops a payload with no message in it. Moving
    // that guard up here would force the next event type to re-implement it.
    expect(dispatchRemoteEvent(asEngine(fake), 'Message', { event: 'Message' })).toBe(true);
    expect(fake.emitInbound).toHaveBeenCalledWith({ event: 'Message' });
  });
});
