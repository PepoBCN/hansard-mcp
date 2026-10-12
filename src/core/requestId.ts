import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID-shaped, lexicographically sortable, generated server-side.
 *
 * This exists because the incident that motivated the rebuild was undiagnosable:
 * the only identifier available belonged to the client layer, and the server had
 * never seen it. Every response and every log line now carries one of these.
 */
export function newRequestId(now: number = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i += 1) {
    ts = CROCKFORD[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i += 1) rand += CROCKFORD[bytes[i]! % 32]!;
  return ts + rand;
}
