import Redis from 'ioredis';
import { config } from './config.js';

const P = 'bn';
export const channels = {
  game: (id) => `${P}:ch:game:${id}`,
  user: (id) => `${P}:ch:user:${id}`,
  presence: `${P}:ch:presence`,
};
const keys = {
  game: (id) => `${P}:game:${id}`,
  log: (id) => `${P}:game:${id}:log`,
  deadlines: `${P}:deadlines`,
  active: (userId) => `${P}:active:${userId}`,
  queue: `${P}:queue`,
  room: (code) => `${P}:room:${code}`,
  command: (userId, id) => `${P}:cmd:${userId}:${id}`,
  presenceConns: `${P}:presence:conns`,
  presenceConnInfo: `${P}:presence:conninfo`,
  presenceCounts: `${P}:presence:counts`,
  presenceUsers: `${P}:presence:users`,
};

// Écriture atomique : compare-and-set sur seq, journal Stream, puis diffusion Pub/Sub.
// Le script tient la cohérence entre instances sans verrou applicatif.
const APPLY_LUA = `
local gameKey, logKey, deadlinesKey, cmdKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local expected, newSeq, state, channel = tonumber(ARGV[1]), tonumber(ARGV[2]), ARGV[3], ARGV[4]
local deadline, gameId, ttl, maxLen = ARGV[5], ARGV[6], tonumber(ARGV[7]), ARGV[8]
if cmdKey ~= '-' and redis.call('EXISTS', cmdKey) == 1 then return 'duplicate' end
local current = tonumber(redis.call('HGET', gameKey, 'seq') or '0')
if current ~= expected then return 'conflict' end
redis.call('HSET', gameKey, 'seq', newSeq, 'state', state)
redis.call('EXPIRE', gameKey, ttl)
for i = 9, #ARGV, 2 do
  redis.call('XADD', logKey, 'MAXLEN', '~', maxLen, '0-' .. ARGV[i], 'e', ARGV[i + 1])
  redis.call('PUBLISH', channel, ARGV[i + 1])
end
redis.call('EXPIRE', logKey, ttl)
if deadline == '0' then redis.call('ZREM', deadlinesKey, gameId)
else redis.call('ZADD', deadlinesKey, deadline, gameId) end
if cmdKey ~= '-' then redis.call('SET', cmdKey, '1', 'EX', 600) end
return 'ok'
`;

// Le premier arrivé attend, le suivant forme une paire. Atomique : deux instances ne peuvent
// pas apparier le même joueur deux fois.
const QUEUE_LUA = `
local me = ARGV[1]
redis.call('LREM', KEYS[1], 0, me)
while true do
  local other = redis.call('LPOP', KEYS[1])
  if not other then break end
  if other ~= me then return other end
end
redis.call('RPUSH', KEYS[1], me)
return false
`;

const PRESENCE_ADD_LUA = `
local connsKey, infoKey, countsKey, usersKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local connId, userId, user, score = ARGV[1], ARGV[2], ARGV[3], ARGV[4]
if redis.call('ZADD', connsKey, score, connId) == 0 then return 0 end
redis.call('HSET', infoKey, connId, userId)
redis.call('HSET', usersKey, userId, user)
return redis.call('HINCRBY', countsKey, userId, 1) == 1 and 1 or 0
`;

// ZREM rend l'opération idempotente : fermeture propre et balayage peuvent se croiser.
const PRESENCE_REMOVE_LUA = `
local connsKey, infoKey, countsKey, usersKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local connId = ARGV[1]
if redis.call('ZREM', connsKey, connId) == 0 then return false end
local userId = redis.call('HGET', infoKey, connId)
redis.call('HDEL', infoKey, connId)
if not userId then return false end
if redis.call('HINCRBY', countsKey, userId, -1) <= 0 then
  redis.call('HDEL', countsKey, userId)
  redis.call('HDEL', usersKey, userId)
  return userId
end
return false
`;

export class Store {
  constructor() {
    const retryStrategy = (times) => Math.min(times * 200, 2000);
    this.redis = new Redis(config.redisUrl, { retryStrategy, maxRetriesPerRequest: 3 });
    this.sub = new Redis(config.redisUrl, { retryStrategy });
    this.redis.defineCommand('applyGame', { numberOfKeys: 4, lua: APPLY_LUA });
    this.redis.defineCommand('queueOrMatch', { numberOfKeys: 1, lua: QUEUE_LUA });
    this.redis.defineCommand('presenceAdd', { numberOfKeys: 4, lua: PRESENCE_ADD_LUA });
    this.redis.defineCommand('presenceRemove', { numberOfKeys: 4, lua: PRESENCE_REMOVE_LUA });
  }

  async ping() { return this.redis.ping(); }

  async loadGame(id) {
    const raw = await this.redis.hget(keys.game(id), 'state');
    return raw ? JSON.parse(raw) : null;
  }

  /**
   * Enregistre `game` et ses événements si personne n'a écrit depuis `expectedSeq`.
   * @returns {'ok'|'conflict'|'duplicate'}
   */
  applyGame(game, expectedSeq, envelopes, commandKey) {
    const args = envelopes.flatMap((e) => [e.seq, JSON.stringify(e)]);
    return this.redis.applyGame(
      keys.game(game.id), keys.log(game.id), keys.deadlines, commandKey ?? '-',
      expectedSeq, game.seq, JSON.stringify(game), channels.game(game.id),
      game.deadline ?? 0, game.id, config.gameTtlSeconds, config.streamMaxLen, ...args,
    );
  }

  commandKey(userId, id) { return keys.command(userId, id); }

  /** @returns événements de seq > lastSeq, ou null si le journal ne remonte plus assez loin. */
  async eventsAfter(gameId, lastSeq) {
    const rows = await this.redis.xrange(keys.log(gameId), `(0-${lastSeq}`, '+');
    const events = rows.map(([, fields]) => JSON.parse(fields[1]));
    if (events.length && events[0].seq !== lastSeq + 1) return null;
    return events;
  }

  dueGames(now) { return this.redis.zrangebyscore(keys.deadlines, 0, now, 'LIMIT', 0, 100); }

  setActive(userId, gameId) { return this.redis.set(keys.active(userId), gameId, 'EX', config.gameTtlSeconds); }
  getActive(userId) { return this.redis.get(keys.active(userId)); }
  clearActive(userId, gameId) {
    return this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
      1, keys.active(userId), gameId,
    );
  }

  queueOrMatch(user) { return this.redis.queueOrMatch(keys.queue, JSON.stringify(user)); }
  leaveQueue(user) { return this.redis.lrem(keys.queue, 0, JSON.stringify(user)); }

  createRoom(code, host, ttlSeconds) { return this.redis.set(keys.room(code), JSON.stringify(host), 'EX', ttlSeconds, 'NX'); }
  async takeRoom(code) {
    const raw = await this.redis.getdel(keys.room(code));
    return raw ? JSON.parse(raw) : null;
  }

  presenceKeys() { return [keys.presenceConns, keys.presenceConnInfo, keys.presenceCounts, keys.presenceUsers]; }
  presenceAdd(connId, user, now) {
    return this.redis.presenceAdd(...this.presenceKeys(), connId, user.id, JSON.stringify(user), now);
  }
  presenceRemove(connId) { return this.redis.presenceRemove(...this.presenceKeys(), connId); }
  presenceTouch(connIds, now) {
    if (connIds.length === 0) return null;
    return this.redis.zadd(keys.presenceConns, 'XX', ...connIds.flatMap((id) => [now, id]));
  }
  presenceExpired(before) { return this.redis.zrangebyscore(keys.presenceConns, 0, before, 'LIMIT', 0, 500); }
  async presenceSnapshot(limit) {
    const total = await this.redis.hlen(keys.presenceUsers);
    const [, flat] = await this.redis.hscan(keys.presenceUsers, 0, 'COUNT', limit);
    const users = [];
    for (let i = 1; i < flat.length && users.length < limit; i += 2) users.push(JSON.parse(flat[i]));
    return { total, users };
  }
  async presenceSetStatus(user) {
    await this.redis.hset(keys.presenceUsers, user.id, JSON.stringify(user));
    return this.redis.hexists(keys.presenceCounts, user.id);
  }

  publish(channel, message) { return this.redis.publish(channel, JSON.stringify(message)); }
  async close() {
    this.sub.disconnect();
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
