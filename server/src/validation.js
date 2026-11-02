import Ajv from 'ajv';
import { CLIENT_MESSAGES, LIMITS } from '../../shared/protocol.js';

const ajv = new Ajv({ allErrors: false, strict: false });

const envelope = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['id', 'type', 'payload'],
  properties: {
    id: { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' },
    type: { type: 'string', maxLength: 32 },
    payload: { type: 'object' },
  },
});

const payloads = new Map(Object.entries(CLIENT_MESSAGES).map(([type, def]) => [type, ajv.compile(def.payload)]));

const describe = (errors, prefix) => {
  const [e] = errors;
  return `${prefix}${e.instancePath} ${e.message}`.trim();
};

/**
 * Valide une trame texte brute. Ne lève jamais : toute entrée hostile devient une erreur typée.
 * @returns {{ ok: true, msg: object } | { ok: false, code: string, message: string, ref: string|null }}
 */
export function parseClientMessage(raw) {
  if (Buffer.byteLength(raw) > LIMITS.MAX_MESSAGE_BYTES) {
    return { ok: false, code: 'TOO_LARGE', message: `Limite : ${LIMITS.MAX_MESSAGE_BYTES} octets`, ref: null };
  }
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'BAD_JSON', message: 'JSON illisible', ref: null };
  }
  if (!envelope(msg)) {
    return { ok: false, code: 'INVALID_MESSAGE', message: describe(envelope.errors, 'enveloppe'), ref: null };
  }
  const validate = payloads.get(msg.type);
  if (!validate) return { ok: false, code: 'UNKNOWN_TYPE', message: `Type inconnu : ${msg.type}`, ref: msg.id };
  if (!validate(msg.payload)) {
    return { ok: false, code: 'INVALID_MESSAGE', message: describe(validate.errors, 'payload'), ref: msg.id };
  }
  return { ok: true, msg };
}

/** Seau à jetons : débit moyen limité, rafales courtes tolérées. */
export class TokenBucket {
  constructor(ratePerSecond, burst, now = Date.now()) {
    Object.assign(this, { ratePerSecond, burst, tokens: burst, last: now });
  }

  take(now = Date.now()) {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
