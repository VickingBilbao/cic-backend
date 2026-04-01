/**
 * CIC Backend — Entry Point (completo Semanas 1-4)
 * Node 22 + Fastify 4
 *
 * Registra todos plugins, rotas e workers BullMQ.
 * Workers rodam in-process. Para produção com alta escala,
 * extraia workers para um processo separado com `--worker` flag.
 */

import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------
import supabasePlugin from './src/plugins/supabase.js'
import redisPlugin    from './src/plugins/redis.js'
import authPlugin     from './src/plugins/auth.js'
import lgpdPlugin     from './src/plugins/lgpd.js'

// ---------------------------------------------------------------------------
// Routes — Semana 1 (Foundation)
// ---------------------------------------------------------------------------
import authRoutes         from './src/routes/auth.js'
import campaignRoutes     from './src/routes/campaigns.js'
import dashboardRoutes    from './src/routes/dashboard.js'
import demandasRoutes     from './src/routes/demandas.js'
import configRoutes       from './src/routes/config.js'

// ---------------------------------------------------------------------------
// Routes — Semana 2 (AI + Agents)
// ---------------------------------------------------------------------------
import iaRoutes           from './src/routes/ia.js'
import contentRoutes      from './src/routes/content.js'
import diagnosticoRoutes  from './src/routes/diagnostico.js'
import monitoramentoRoutes from './src/routes/monitoramento.js'
import crmRoutes          from './src/routes/crm.js'
import fundraisingRoutes  from './src/routes/fundraising.js'
import comunicacaoRoutes  from './src/routes/comunicacao.js'
import voluntariosRoutes  from './src/routes/voluntarios.js'
import producaoRoutes     from './src/routes/producao.js'
import agendaRoutes       from './src/routes/agenda.js'
import debateRoutes       from './src/routes/debate.js'
import relatoriosRoutes   from './src/routes/relatorios.js'
import pesquisasRoutes    from './src/routes/pesquisas.js'
import gotvRoutes         from './src/routes/gotv.js'
import mapaRoutes         from './src/routes/mapa.js'
import estrategiaRoutes   from './src/routes/estrategia.js'
import socialRoutes       from './src/routes/social.js'

// ---------------------------------------------------------------------------
// Routes — Semana 3 (Image + Avatar)
// ---------------------------------------------------------------------------
import imageRoutes        from './src/routes/image.js'
import avatarRoutes       from './src/routes/avatar.js'

// ---------------------------------------------------------------------------
// Routes — Semana 4 (Polish + Live)
// ---------------------------------------------------------------------------
import obsidianRoutes     from './src/routes/obsidian.js'
import orgRoutes          from './src/routes/org.js'
import sadminRoutes       from './src/routes/sadmin.js'

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------
import { startTextWorker }       from './src/workers/text.worker.js'
import { startImageWorker }      from './src/workers/image.worker.js'
import { startVideoWorker }      from './src/workers/video.worker.js'
import { startMonitoringWorker } from './src/workers/monitoring.worker.js'

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------
const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
})

// ---------------------------------------------------------------------------
// Fastify core plugins
// ---------------------------------------------------------------------------
await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN ?? '*',
  credentials: true,
})

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'cic-dev-secret-change-in-production',
  sign: { expiresIn: '7d' },
})

await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  allowList: ['127.0.0.1'],
  keyGenerator: req => req.headers['x-forwarded-for'] ?? req.ip,
})

await fastify.register(multipart, {
  limits: { fileSize: 20 * 1024 * 1024 },   // 20 MB
})

// App plugins (order matters: supabase → redis → auth → lgpd)
await fastify.register(supabasePlugin)
await fastify.register(redisPlugin)
await fastify.register(authPlugin)
await fastify.register(lgpdPlugin)            // adds headers + /lgpd/* endpoints

// ---------------------------------------------------------------------------
// Routes — all under /api/v1
// ---------------------------------------------------------------------------
const API = '/api/v1'
const CAMP = `${API}/campaigns`

// Auth + campaigns (top-level)
await fastify.register(authRoutes,          { prefix: API })
await fastify.register(campaignRoutes,      { prefix: API })

// Campaign-scoped modules
await fastify.register(dashboardRoutes,     { prefix: CAMP })
await fastify.register(demandasRoutes,      { prefix: CAMP })
await fastify.register(configRoutes,        { prefix: CAMP })
await fastify.register(iaRoutes,            { prefix: CAMP })
await fastify.register(contentRoutes,       { prefix: API })   // /api/v1/content/*
await fastify.register(diagnosticoRoutes,   { prefix: CAMP })
await fastify.register(monitoramentoRoutes, { prefix: CAMP })
await fastify.register(crmRoutes,           { prefix: CAMP })
await fastify.register(fundraisingRoutes,   { prefix: CAMP })
await fastify.register(comunicacaoRoutes,   { prefix: CAMP })
await fastify.register(voluntariosRoutes,   { prefix: CAMP })
await fastify.register(producaoRoutes,      { prefix: CAMP })
await fastify.register(agendaRoutes,        { prefix: CAMP })
await fastify.register(debateRoutes,        { prefix: CAMP })
await fastify.register(relatoriosRoutes,    { prefix: CAMP })
await fastify.register(pesquisasRoutes,     { prefix: CAMP })
await fastify.register(gotvRoutes,          { prefix: CAMP })
await fastify.register(mapaRoutes,          { prefix: CAMP })
await fastify.register(estrategiaRoutes,    { prefix: CAMP })
await fastify.register(socialRoutes,        { prefix: CAMP })
await fastify.register(imageRoutes,         { prefix: CAMP })
await fastify.register(avatarRoutes,        { prefix: CAMP })
await fastify.register(obsidianRoutes,      { prefix: CAMP })
await fastify.register(orgRoutes,           { prefix: `${API}/org` })
await fastify.register(sadminRoutes,        { prefix: `${API}/sadmin` })

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
fastify.get('/health', async () => ({
  status: 'ok',
  version: process.env.npm_package_version ?? '1.0.0',
  env: process.env.NODE_ENV ?? 'development',
  timestamp: new Date().toISOString(),
}))

fastify.get('/api/v1/status', {
  onRequest: [fastify.authenticate],
}, async (request) => ({
  status: 'authenticated',
  user: { id: request.user.id, email: request.user.email, role: request.user.role },
  timestamp: new Date().toISOString(),
}))

// ---------------------------------------------------------------------------
// BullMQ Workers — start after server is ready (Redis connection available)
// ---------------------------------------------------------------------------
fastify.ready(err => {
  if (err) { fastify.log.error(err); process.exit(1) }

  const connection = fastify.redis

  startTextWorker(connection)        // Claude text generation    (concurrency 3)
  startImageWorker(connection)       // Gemini Nano Banana 2      (concurrency 2)
  startVideoWorker(connection)       // HeyGen avatar video       (concurrency 1)
  startMonitoringWorker(connection)  // Claude sentiment analysis  (concurrency 3)

  fastify.log.info('✅ All BullMQ workers started (text · image · video · monitoring)')
})

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
const shutdown = async signal => {
  fastify.log.info(`${signal} received — shutting down gracefully`)
  await fastify.close()
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
try {
  const port = parseInt(process.env.PORT ?? '3001', 10)
  const host = process.env.HOST ?? '0.0.0.0'
  await fastify.listen({ port, host })
  fastify.log.info(`🚀 CIC Backend on http://${host}:${port}`)
  fastify.log.info(`📋 API prefix: ${API}`)
  fastify.log.info(`🔒 LGPD compliance: enabled`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
