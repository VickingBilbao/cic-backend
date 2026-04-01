/**
 * CIC Backend — Modo LITE
 *
 * Roda SEM Redis e SEM workers BullMQ.
 * Use para testar a interface durante setup inicial.
 *
 * Funciona:
 *   ✅ Login / autenticação
 *   ✅ Campanhas CRUD
 *   ✅ Dashboard KPIs
 *   ✅ Chat IA (Claude streaming SSE)
 *   ✅ Todos os módulos de dados
 *   ✅ Monitoramento, CRM, Agenda...
 *
 * Não disponível no lite:
 *   ⏳ Geração de imagem (precisa Redis)
 *   ⏳ Geração de vídeo avatar (precisa Redis)
 *   ⏳ Análise de sentimento em batch (precisa Redis)
 *
 * Para modo completo: node index.js (precisa Redis rodando)
 */

import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import multipart from '@fastify/multipart'

import supabasePlugin from './src/plugins/supabase.js'
import authPlugin     from './src/plugins/auth.js'
import lgpdPlugin     from './src/plugins/lgpd.js'

import authRoutes         from './src/routes/auth.js'
import campaignRoutes     from './src/routes/campaigns.js'
import dashboardRoutes    from './src/routes/dashboard.js'
import demandasRoutes     from './src/routes/demandas.js'
import configRoutes       from './src/routes/config.js'
import iaRoutes           from './src/routes/ia.js'
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
import obsidianRoutes     from './src/routes/obsidian.js'

const fastify = Fastify({
  logger: {
    level: 'info',
    transport: { target: 'pino-pretty', options: { colorize: true } },
  },
})

await fastify.register(cors, { origin: '*', credentials: true })
await fastify.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'cic-dev-lite',
  sign: { expiresIn: '7d' },
})
await fastify.register(rateLimit, { max: 200, timeWindow: '1 minute' })
await fastify.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } })
await fastify.register(supabasePlugin)
await fastify.register(authPlugin)
await fastify.register(lgpdPlugin)

const API  = '/api/v1'
const CAMP = `${API}/campaigns`

// Auth routes:    POST /api/v1/auth/login, GET /api/v1/auth/me, etc.
await fastify.register(authRoutes,          { prefix: `${API}/auth` })
// Campaign CRUD:  GET/POST /api/v1/campaigns, GET/PATCH/DELETE /api/v1/campaigns/:id
await fastify.register(campaignRoutes,      { prefix: CAMP })
// Dashboard:      GET /api/v1/campaigns/:id/dashboard, /health, /alerts
await fastify.register(dashboardRoutes,     { prefix: CAMP })
await fastify.register(demandasRoutes,      { prefix: CAMP })
// Config/equipe:  GET /api/v1/users/me, GET /api/v1/campaigns/:id/equipe
await fastify.register(configRoutes,        { prefix: API })
await fastify.register(iaRoutes,            { prefix: CAMP })
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
await fastify.register(obsidianRoutes,      { prefix: CAMP })

fastify.get('/health', async () => ({
  status: 'ok', mode: 'lite',
  timestamp: new Date().toISOString(),
}))

const shutdown = async s => { await fastify.close(); process.exit(0) }
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

try {
  const port = parseInt(process.env.PORT ?? '3001', 10)
  await fastify.listen({ port, host: '0.0.0.0' })
  console.log(`\n🚀 CIC Lite rodando em http://localhost:${port}`)
  console.log(`📋 API: http://localhost:${port}/api/v1`)
  console.log(`❤️  Health: http://localhost:${port}/health\n`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
