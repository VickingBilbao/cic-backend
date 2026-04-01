/**
 * LGPD Compliance Plugin — Fastify
 * CIC — Centro de Inteligência de Campanha
 *
 * Lei Geral de Proteção de Dados (Lei nº 13.709/2018)
 *
 * This plugin:
 *  1. Adds security + privacy headers to every response (Helmet-like)
 *  2. Registers a consent log decorator: fastify.logConsent()
 *  3. Adds public endpoints for consent management and data subject rights
 *
 * Endpoints (no auth required):
 *   GET  /lgpd/politica        — Privacy policy JSON summary
 *   POST /lgpd/consentimento   — Record user consent
 *
 * Endpoints (auth required):
 *   GET  /lgpd/meus-dados      — Data subject access request (DSAR)
 *   POST /lgpd/deletar-dados   — Right to erasure
 */

import fp from 'fastify-plugin'
import { createHash } from 'node:crypto'

// Hash IP for privacy-preserving storage (one-way, truncated)
function hashIp(ip) {
  return createHash('sha256')
    .update(ip + (process.env.IP_SALT ?? 'cic-lgpd-salt'))
    .digest('hex')
    .slice(0, 16)
}

async function lgpdPlugin(fastify, opts) {
  const { supabase } = fastify

  // -------------------------------------------------------------------------
  // 1. Security headers on every response
  // -------------------------------------------------------------------------
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-XSS-Protection', '1; mode=block')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co wss://*.supabase.co"
    )
    if (process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload')
    }
  })

  // -------------------------------------------------------------------------
  // 2. Consent log decorator (used by other plugins/routes)
  // -------------------------------------------------------------------------
  fastify.decorate('logConsent', async function ({ userId, tipo, aceito, ip, userAgent }) {
    try {
      await supabase.from('lgpd_consentimentos').insert({
        user_id: userId ?? null,
        tipo,
        aceito,
        ip_hash: ip ? hashIp(ip) : null,
        user_agent: userAgent?.slice(0, 200) ?? null,
      })
    } catch (e) {
      fastify.log.warn(`logConsent failed: ${e.message}`)
    }
  })

  // -------------------------------------------------------------------------
  // 3. LGPD public endpoints
  // -------------------------------------------------------------------------

  // GET /lgpd/politica — privacy policy summary
  fastify.get('/lgpd/politica', async () => ({
    versao: '1.0',
    atualizadoEm: '2026-01-01',
    controlador: {
      nome: 'CIC — Centro de Inteligência de Campanha',
      contato: 'privacidade@cic.app',
    },
    finalidades: [
      'Gestão de campanha eleitoral',
      'Comunicação com eleitores mediante consentimento expresso',
      'Análise de dados eleitorais agregados e anonimizados',
    ],
    basesLegais: [
      { base: 'Consentimento', artigo: 'Art. 7º, I' },
      { base: 'Legítimo interesse', artigo: 'Art. 7º, IX' },
      { base: 'Exercício regular de direitos', artigo: 'Art. 7º, VI' },
    ],
    retencao: '5 anos após encerramento da campanha, conforme legislação eleitoral',
    direitos: ['acesso', 'correcao', 'exclusao', 'portabilidade', 'revogacao_consentimento'],
    contato_dpo: 'dpo@cic.app',
  }))

  // POST /lgpd/consentimento — record consent
  fastify.post('/lgpd/consentimento', {
    schema: {
      body: {
        type: 'object', required: ['tipo', 'aceito'],
        properties: {
          tipo:   { type: 'string', enum: ['marketing', 'analytics', 'comunicacao', 'todos'] },
          aceito: { type: 'boolean' },
          userId: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    await fastify.logConsent({
      userId: request.body.userId ?? null,
      tipo: request.body.tipo,
      aceito: request.body.aceito,
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    })
    return reply.status(201).send({ ok: true, registradoEm: new Date().toISOString() })
  })

  // GET /lgpd/meus-dados — data subject access request
  fastify.get('/lgpd/meus-dados', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const userId = request.user.id
    const [profile, historico, consentimentos] = await Promise.all([
      supabase.from('profiles').select('*').eq('id', userId).single(),
      supabase.from('ia_historico').select('mensagem, resposta, agente, created_at')
        .eq('user_id', userId).order('created_at').limit(100),
      supabase.from('lgpd_consentimentos').select('tipo, aceito, created_at')
        .eq('user_id', userId),
    ])
    return {
      perfil: profile.data ?? {},
      historico_ia: historico.data ?? [],
      consentimentos: consentimentos.data ?? [],
      geradoEm: new Date().toISOString(),
    }
  })

  // POST /lgpd/deletar-dados — right to erasure
  fastify.post('/lgpd/deletar-dados', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object', required: ['confirmacao'],
        properties: {
          confirmacao: { type: 'string', const: 'CONFIRMO EXCLUSÃO DOS MEUS DADOS' },
          motivo: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const userId = request.user.id
    await Promise.all([
      supabase.from('ia_historico').delete().eq('user_id', userId),
      supabase.from('lgpd_consentimentos').delete().eq('user_id', userId),
      supabase.from('profiles').update({
        nome: '[DADOS REMOVIDOS]',
        telefone: null,
        avatar_url: null,
        metadados: { deletado: true, deletadoEm: new Date().toISOString() },
      }).eq('id', userId),
    ])
    // Delete auth user (via Supabase admin)
    await supabase.auth.admin.deleteUser(userId)
    return { ok: true, mensagem: 'Dados pessoais removidos conforme Art. 18 da LGPD.' }
  })
}

export default fp(lgpdPlugin)
