/**
 * Agenda Routes — /api/v1/campaigns/:id/agenda/*
 * CIC — Centro de Inteligência de Campanha
 */

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export default async function agendaRoutes(fastify) {

  // ── GET — listar eventos ─────────────────────────────────────────────────
  fastify.get('/:id/agenda', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { vista = 'semana' } = req.query
    let query = fastify.supabase.from('agenda')
      .select('*').eq('campaign_id', req.params.id)
      .order('inicio', { ascending: true })

    const now = new Date()
    if (vista === 'hoje') {
      const fim = new Date(now); fim.setHours(23, 59, 59, 999)
      query = query.gte('inicio', now.toISOString()).lte('inicio', fim.toISOString())
    }
    if (vista === 'semana') {
      const fim = new Date(now); fim.setDate(fim.getDate() + 7)
      query = query.gte('inicio', now.toISOString()).lte('inicio', fim.toISOString())
    }
    if (vista === 'mes') {
      const fim = new Date(now); fim.setMonth(fim.getMonth() + 1)
      query = query.gte('inicio', now.toISOString()).lte('inicio', fim.toISOString())
    }

    const { data, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { compromissos: data }
  })

  // ── POST — criar evento ──────────────────────────────────────────────────
  fastify.post('/:id/agenda', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase.from('agenda')
      .insert({ ...req.body, campaign_id: req.params.id }).select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ compromisso: data })
  })

  // ── DELETE ───────────────────────────────────────────────────────────────
  fastify.delete('/:id/agenda/:aid', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { error } = await fastify.supabase.from('agenda').delete()
      .eq('id', req.params.aid).eq('campaign_id', req.params.id)
    if (error) return reply.status(400).send({ error: error.message })
    return { message: 'Compromisso removido' }
  })

  // ── GET briefing — Claude gera briefing real com contexto estratégico ────
  fastify.get('/:id/agenda/:aid/briefing', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data: comp } = await fastify.supabase
      .from('agenda').select('*').eq('id', req.params.aid).single()
    if (!comp) return reply.status(404).send({ error: 'Compromisso não encontrado' })

    // Contexto da campanha em paralelo
    const [campanha, decisoes, alertas, monitoramento] = await Promise.all([
      fastify.supabase.from('campaigns').select('name, city, state, cargo').eq('id', req.params.id).single(),
      fastify.supabase.from('decisoes').select('titulo, descricao').eq('campaign_id', req.params.id).eq('status', 'aprovada').order('created_at', { ascending: false }).limit(4),
      fastify.supabase.from('monitoring_events').select('content, sentiment').eq('campaign_id', req.params.id).eq('urgente', true).order('created_at', { ascending: false }).limit(3),
      fastify.supabase.from('monitoring_events').select('topicos').eq('campaign_id', req.params.id).order('created_at', { ascending: false }).limit(10),
    ])

    const cand    = campanha.data?.name  || 'Candidato'
    const cargo   = campanha.data?.cargo || 'cargo político'
    const cidade  = campanha.data?.city  || 'cidade'

    const topicos = [...new Set(
      (monitoramento.data || []).flatMap(m => m.topicos || [])
    )].slice(0, 8).join(', ')

    const ctxDecisoes  = (decisoes.data  || []).map(d => `• ${d.titulo}`).join('\n') || '(sem decisões recentes)'
    const ctxAlertas   = (alertas.data   || []).map(a => `• ${a.content?.slice(0, 120)}`).join('\n') || '(sem alertas críticos)'

    try {
      const res = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 900,
        system: `Você é um estrategista político sênior especializado em campanhas eleitorais brasileiras.
Elabore um briefing executivo conciso, acionável e direto ao ponto.
Use markdown com seções claras. Máximo 450 palavras. Foco em preparação prática.`,
        messages: [{
          role: 'user',
          content: `COMPROMISSO
Candidato: ${cand} | ${cargo} | ${cidade}
Evento: ${comp.titulo}
Data/Hora: ${comp.inicio ? new Date(comp.inicio).toLocaleString('pt-BR') : 'a confirmar'}
Local: ${comp.local || 'a confirmar'}
Tipo: ${comp.tipo || 'geral'}
${comp.descricao ? `Detalhes: ${comp.descricao}` : ''}

CONTEXTO ESTRATÉGICO
Últimas decisões aprovadas:
${ctxDecisoes}

Alertas ativos:
${ctxAlertas}

Tópicos em alta no monitoramento: ${topicos || 'nenhum disponível'}

Gere um briefing com as seções:
## 🎯 Objetivo
## 📋 Pontos-chave para abordar
## ⚠️ Pontos de atenção
## 💬 Mensagem central recomendada
## ✅ Checklist de preparação`,
        }],
      })

      return {
        briefing:      res.content[0].text,
        gerado_ia:     true,
        compromisso:   comp,
        tokens_usados: res.usage?.output_tokens,
      }
    } catch (err) {
      return {
        briefing: `## ${comp.titulo}\n\n**Local:** ${comp.local || 'a confirmar'}\n**Hora:** ${comp.inicio ? new Date(comp.inicio).toLocaleString('pt-BR') : 'a confirmar'}\n\n## 🎯 Objetivo\nRepresentar ${cand} com excelência e consistência.\n\n## 📋 Pontos-chave\n- Proposta central da campanha\n- Conexão com demandas de ${cidade}\n- Chamada à ação clara\n\n## 💬 Mensagem central\nConsistência, presença e escuta ativa.`,
        gerado_ia: false,
        fallback:  err.message,
      }
    }
  })
}
