const int = (name, fallback) => {
  const value = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(value) ? value : fallback;
};

export const config = {
  port: int('PORT', 3000),
  instance: process.env.INSTANCE_ID ?? 'game-local',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me-please',
  jwtTtlSeconds: int('JWT_TTL_SECONDS', 604800), // 7 jours : la session survit à la fermeture du navigateur
  allowedOrigins: new Set(
    (process.env.ALLOWED_ORIGINS ?? 'http://localhost:8088,https://localhost:8443')
      .split(',').map((s) => s.trim()).filter(Boolean),
  ),
  turnMs: int('TURN_MS', 45000),
  placementMs: int('PLACEMENT_MS', 120000),
  heartbeatMs: int('HEARTBEAT_MS', 5000),
  presenceTtlMs: int('PRESENCE_TTL_MS', 15000),
  presenceBatchMs: int('PRESENCE_BATCH_MS', 500),
  rateLimitPerSecond: int('RATE_LIMIT_PER_SECOND', 20),
  rateLimitBurst: int('RATE_LIMIT_BURST', 40),
  rateLimitMaxStrikes: int('RATE_LIMIT_MAX_STRIKES', 50),
  gameTtlSeconds: int('GAME_TTL_SECONDS', 7200),
  streamMaxLen: int('STREAM_MAX_LEN', 2000),
};
