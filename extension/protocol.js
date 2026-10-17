// @ts-check
import { fault } from './runtime-errors.js';

/**
 * Protocol 3 wire contracts. Validators additionally enforce bounds and role rights.
 * @typedef {'host' | 'guest'} Role
 * @typedef {({type: 'seek', time: number} | {type: 'play' | 'pause', time?: number}) &
 *   {at?: number, advancing?: boolean, epoch?: number | null} &
 *   ({id: number, mediaId: string} | {id?: undefined, mediaId?: string})} Intent
 * @typedef {{time: number, duration: number, paused: boolean, buffering: boolean,
 *   mediaId: string, blocked?: boolean, at?: number, advancing?: boolean,
 *   adapter?: string, intents?: Intent[]}} Sample
 * @typedef {{phase: 'aligning' | 'synced', epoch: number, revision: number, at: number,
 *   position: number, playing: boolean, wantsPlay: boolean, waiting: boolean,
 *   anchors: Partial<Record<Role, number>>,
 *   members: Record<Role, {present: boolean, ready: boolean, blocked: boolean}>,
 *   acknowledgedIntents?: Partial<Record<Role, {id: number, mediaId: string, revision: number}>>}} State
 * @typedef {{type: 'ping', sent: number} | {type: 'pong', sent: number, received: number} |
 *   {type: 'state', state: State, resetId?: string} | {type: 'sample', sample: Sample} |
 *   {type: 'ready', epoch: number} | {type: 'resync', requestId: string} |
 *   {type: 'intent', epoch: number, intent: Intent}} Message
 * @typedef {{sequence: number, messages: Message[]}} Batch
 * @typedef {{protocol: 3, code: string, token: string, role: Role,
 *   capabilities: string[], peerCapabilities: string[]}} Member
 * @typedef {{id: number} & ({type: 'room-closed'} | {type: 'peer-joined', capabilities: string[]} |
 *   {type: 'data', at: number, ageMs?: number, message: Message})} RoomEvent
 */

// Clients and servers of another protocol number reject each other with
// INCOMPATIBLE_PROTOCOL, which the popup shows as a request to update.
export const PROTOCOL = 3;
export const CAPABILITIES = Object.freeze(['relay-v2', 'structured-errors-v1']);
// Six readable invitation characters address a room.
export const SHORT_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE = /^[A-Z2-9]{6}$/;
/** @param {unknown} code */
export const validRoomCode = code => typeof code === 'string' && ROOM_CODE.test(code);
// messageBytes bounds one normalized message as serialized JSON. It covers a
// sample carrying the maximum of 20 intents with 128-character ASCII IDs
// (about 5.9 KB); a real sample with UUID media IDs stays below 4 KB.
export const LIMITS = Object.freeze({ mediaSeconds: 1e9, mediaId: 128, requestId: 64, messages: 32, events: 256, intents: 20, messageBytes: 6144 });
/** @param {unknown} value @returns {value is Record<string, unknown>} */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @param {number} [min] @param {number} [max] @returns {value is number} */
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
/** @param {unknown} value @param {number} [min] @returns {value is number} */
const integer = (value, min = 0) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
/** @param {unknown} value @param {number} max @returns {value is string} */
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
/** @param {unknown} value @returns {value is boolean} */
const boolean = value => typeof value === 'boolean';
/** @param {Record<string, unknown>} value @param {string} key @param {(value: unknown) => boolean} validate */
const optional = (value, key, validate) => value[key] === undefined || validate(value[key]);
/** @param {unknown} role @returns {role is Role} */
export const validRole = role => role === 'host' || role === 'guest';
/** @param {Role} role @returns {Role} */
export const peerRole = role => role === 'host' ? 'guest' : 'host';
/** @param {unknown} value @returns {value is number} */
const mediaTime = value => number(value, 0, LIMITS.mediaSeconds);
/** @param {unknown} value @returns {value is string} */
const mediaId = value => string(value, LIMITS.mediaId);

/** @param {unknown} intent @returns {intent is Intent} */
export function validIntent(intent) {
  return record(intent) && typeof intent.type === 'string' && ['play', 'pause', 'seek'].includes(intent.type) &&
    (intent.type !== 'seek' || mediaTime(intent.time)) && optional(intent, 'time', mediaTime) &&
    optional(intent, 'at', number) && optional(intent, 'advancing', boolean) &&
    optional(intent, 'epoch', value => value === null || integer(value)) &&
    optional(intent, 'id', value => integer(value, 1) && mediaId(intent.mediaId)) && optional(intent, 'mediaId', mediaId);
}

/** @param {unknown} sample @returns {sample is Sample} */
export function validSample(sample) {
  return record(sample) && mediaTime(sample.time) && number(sample.duration, Number.MIN_VALUE, LIMITS.mediaSeconds) &&
    boolean(sample.paused) && boolean(sample.buffering) && mediaId(sample.mediaId) &&
    optional(sample, 'blocked', boolean) && optional(sample, 'at', number) && optional(sample, 'advancing', boolean) &&
    optional(sample, 'adapter', value => string(value, 64)) &&
    optional(sample, 'intents', value => Array.isArray(value) && value.length <= LIMITS.intents && value.every(validIntent));
}

/** @param {unknown} state @returns {state is State} */
export function validState(state) {
  if (!record(state) || typeof state.phase !== 'string' || !['aligning', 'synced'].includes(state.phase) || !integer(state.epoch) || !integer(state.revision) ||
      !number(state.at) || !number(state.position, -LIMITS.mediaSeconds, LIMITS.mediaSeconds) ||
      !boolean(state.playing) || !boolean(state.wantsPlay) || !boolean(state.waiting) ||
      !record(state.anchors) || !record(state.members)) return false;
  const { anchors, members, revision } = state;
  if (!Object.keys(anchors).every(validRole) || !Object.values(anchors).every(mediaTime)) return false;
  if (!['host', 'guest'].every(role => {
    const member = members[role];
    return record(member) && ['present', 'ready', 'blocked'].every(key => boolean(member[key])) &&
      (state.phase !== 'synced' || mediaTime(anchors[role]));
  }) || !Object.keys(state.members).every(validRole)) return false;
  if (state.acknowledgedIntents !== undefined && (!record(state.acknowledgedIntents) ||
      !Object.entries(state.acknowledgedIntents).every(([role, ack]) => validRole(role) && record(ack) &&
        integer(ack.id, 1) && mediaId(ack.mediaId) && integer(ack.revision) && ack.revision <= revision))) return false;
  return !state.playing || (state.phase === 'synced' && state.wantsPlay && !state.waiting);
}

/** @param {unknown} message @param {unknown} role @returns {message is Message} */
export function validMessage(message, role) {
  if (!validRole(role) || !record(message)) return false;
  if (message.type === 'ping') return number(message.sent);
  if (message.type === 'pong') return number(message.sent) && number(message.received);
  if (role === 'host') return message.type === 'state' && validState(message.state) && optional(message, 'resetId', value => string(value, LIMITS.requestId));
  if (message.type === 'sample') return validSample(message.sample);
  if (message.type === 'ready') return integer(message.epoch);
  if (message.type === 'resync') return string(message.requestId, LIMITS.requestId);
  return message.type === 'intent' && integer(message.epoch) && validIntent(message.intent);
}

/**
 * Copies only the listed fields that are present. Callers pass validated
 * records, so every copied value is already a bounded primitive.
 * @param {Record<string, unknown>} source @param {readonly string[]} keys
 * @returns {Record<string, unknown>}
 */
function pick(source, keys) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const key of keys) if (source[key] !== undefined) result[key] = source[key];
  return result;
}
const INTENT_FIELDS = Object.freeze(['type', 'time', 'at', 'advancing', 'epoch', 'id', 'mediaId']);
const SAMPLE_FIELDS = Object.freeze(['time', 'duration', 'paused', 'buffering', 'mediaId', 'blocked', 'at', 'advancing', 'adapter']);
const STATE_FIELDS = Object.freeze(['phase', 'epoch', 'revision', 'at', 'position', 'playing', 'wantsPlay', 'waiting']);
const PRESENCE_FIELDS = Object.freeze(['present', 'ready', 'blocked']);
/** @param {Record<string, unknown>} value */
const roles = value => pick(value, ['host', 'guest']);

/**
 * Rebuilds a valid message from its protocol fields only. Unknown fields are
 * tolerated on input but never forwarded, so a relay queues at most the
 * schema-bounded size of each message. Returns null for invalid messages.
 * @param {unknown} message @param {unknown} role @returns {Message | null}
 */
export function normalizeMessage(message, role) {
  if (!validMessage(message, role)) return null;
  /** @type {Record<string, any>} */
  const value = message;
  /** @param {Record<string, unknown>} intent */
  const intent = intent => pick(intent, INTENT_FIELDS);
  if (value.type === 'ping') return /** @type {Message} */ ({ type: 'ping', sent: value.sent });
  if (value.type === 'pong') return /** @type {Message} */ ({ type: 'pong', sent: value.sent, received: value.received });
  if (value.type === 'ready') return /** @type {Message} */ ({ type: 'ready', epoch: value.epoch });
  if (value.type === 'resync') return /** @type {Message} */ ({ type: 'resync', requestId: value.requestId });
  if (value.type === 'intent') return /** @type {Message} */ ({ type: 'intent', epoch: value.epoch, intent: intent(value.intent) });
  if (value.type === 'sample') {
    const sample = pick(value.sample, SAMPLE_FIELDS);
    if (value.sample.intents !== undefined) sample.intents = value.sample.intents.map(intent);
    return /** @type {Message} */ ({ type: 'sample', sample });
  }
  const source = value.state;
  const state = { ...pick(source, STATE_FIELDS), anchors: roles(source.anchors),
    members: { host: pick(source.members.host, PRESENCE_FIELDS), guest: pick(source.members.guest, PRESENCE_FIELDS) } };
  if (source.acknowledgedIntents !== undefined) {
    const acknowledged = roles(source.acknowledgedIntents);
    for (const key of Object.keys(acknowledged)) acknowledged[key] = pick(/** @type {Record<string, unknown>} */ (acknowledged[key]), ['id', 'mediaId', 'revision']);
    Object.assign(state, { acknowledgedIntents: acknowledged });
  }
  return /** @type {Message} */ (value.resetId === undefined ? { type: 'state', state } : { type: 'state', state, resetId: value.resetId });
}

/** @param {unknown} batch @param {unknown} role @returns {batch is Batch} */
export function validBatch(batch, role) {
  return record(batch) && integer(batch.sequence, 1) && Array.isArray(batch.messages) &&
    batch.messages.length > 0 && batch.messages.length <= LIMITS.messages && batch.messages.every(message => validMessage(message, role));
}

/** @param {unknown} value @returns {value is string[]} */
const validCapabilities = value => Array.isArray(value) && value.length <= 32 &&
  value.every(item => typeof item === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(item)) && new Set(value).size === value.length;
// Every handshake and membership names this protocol and its capabilities.
/** @param {unknown} value @returns {string[]} */
export function negotiate(value) {
  if (!record(value) || value.protocol !== PROTOCOL || !validCapabilities(value.capabilities) ||
      !optional(value, 'requiredCapabilities', validCapabilities)) throw fault('INCOMPATIBLE_PROTOCOL', 400);
  if (validCapabilities(value.requiredCapabilities) && value.requiredCapabilities.some(capability => !CAPABILITIES.includes(capability))) throw fault('INCOMPATIBLE_PROTOCOL', 400);
  return value.capabilities.filter(capability => CAPABILITIES.includes(capability));
}

/** @param {unknown} member @param {unknown} expectedRole @returns {member is Member} */
export function validMember(member, expectedRole) {
  return record(member) && member.protocol === PROTOCOL && validRoomCode(member.code) &&
    typeof member.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(member.token) && validRole(member.role) && member.role === expectedRole &&
    validCapabilities(member.capabilities) && validCapabilities(member.peerCapabilities);
}

/** @param {unknown} event @param {unknown} receiverRole @returns {event is RoomEvent} */
export function validEvent(event, receiverRole) {
  if (!validRole(receiverRole) || !record(event) || !integer(event.id, 1)) return false;
  if (event.type === 'room-closed') return true;
  if (event.type === 'peer-joined') return receiverRole === 'host' && validCapabilities(event.capabilities);
  return event.type === 'data' && number(event.at) && optional(event, 'ageMs', number) && validMessage(event.message, peerRole(receiverRole));
}

/** @param {unknown} response @param {unknown} receiverRole @returns {response is {events: RoomEvent[]}} */
export function validEvents(response, receiverRole) {
  return record(response) && Array.isArray(response.events) && response.events.length <= LIMITS.events &&
    response.events.every((event, index, events) => validEvent(event, receiverRole) && (!index || event.id > events[index - 1].id));
}

/** @param {Message} message @returns {string | null} */
export function transientKey(message) {
  return ['sample', 'ping', 'pong'].includes(message.type) || (message.type === 'state' && !message.resetId) ? message.type : null;
}
