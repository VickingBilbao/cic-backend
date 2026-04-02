/**
 * Demandas Routes — /api/v1/campaigns/:id/demandas/*
 * CIC — Centro de Inteligência de Campanha
 */

import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

const MODULOS = {
  roteiro:       { label: 'Produção de Conteúdo', modulo: 'prod',    icon: '🎬' },
  comunicacao:   { label: 'Comunicação & Disparos', modulo: 'comm',  icon: '📣' },
  estrategia:    { label: 'Estratégia', modulo: 'estr',              icon: '♟️' },
  monitoramento: { label: 'Monitoramento', modulo: 'mon',            icon: '📡' },
  social:        { label: 'Redes Sociais', modulo: 'social',         icon: '📱' },
  voluntarios:   { label: 'Voluntários', modulo: 'vol',              icon: '🤝' },
  agenda:        { label: 'Agenda', modulo: 'agenda',                icon: '📅' },
  producao:      { label: 'Produção', modulo: 'prod',                icon: '⚙️' },
}

export default async function demandasRoutes(fastify) {

  // GET /campaigns/:id/demandas
  fastify.get('/:id/demandas', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { status, prioridade } = req.query
    let query = fastify.supabase
      .from('demandas')
      .select('*, assigned_to:profiles!assigned_to(name, email), criado_por:profiles!criado_por(name, email)')
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: false })

    if (status)     query = query.eq('status', status)
    if (prioridade) query = query.eq('prioridade', prioridade)

    const { data, error } = await query
    if (error) return reply.status(500).send({ error: error.message })
    return { demandas: data }
  })

  // POST /campaigns/:id/demandas
  fastify.post('/:id/demandas', {
    preHandler: [fastify.authenticate],
    schema: {
      body: {
        type: 'object',
        required: ['titulo', 'tipo'],
        properties: {
          titulo:     { type: 'string' },
          descricao:  { type: 'string' },
          tipo:       { type: 'string', enum: ['roteiro','comunicacao','estrategia','monitoramento','social','voluntarios','agenda','producao'] },
          prioridade: { type: 'string', enum: ['alta','media','baixa'], default: 'media' },
          prazo:      { type: 'string', format: 'date' },
        },
      },
    },
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('demandas')
      .insert({ ...req.body, campaign_id: req.params.id, criado_por: req.user.id, status: 'nova' })
      .select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ demanda: data })
  })

  // PATCH /campaigns/:id/demandas/:did/status
  fastify.patch('/:id/demandas/:did/status', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const { status } = req.body
    const validStatus = ['nova', 'em_andamento', 'concluida', 'cancelada']
    if (!validStatus.includes(status)) return reply.status(400).send({ error: 'Status inválido' })

    const { data, error } = await fastify.supabase
      .from('demandas')
      .update({ status, updated_at: new Date() })
      .eq('id', req.params.did).eq('campaign_id', req.params.id)
      .select().single()

    if (error) return reply.status(400).send({ error: error.message })
    return { demanda: data }
  })

  // POST /campaigns/:id/demandas/:did/ai-suggest — Claude sugere destino e ações
  fastify.post('/:id/demandas/:did/ai-suggest', {
    preHandler: [fastify.authenticate],
  }, async (req, reply) => {
    const { data: demanda } = await fastify.supabase
      .from('demandas').select('*').eq('id', req.params.did).single()
    if (!demanda) return reply.status(404).send({ error: 'Demanda não encontrada' })

    const { data: camp } = await fastify.supabase
      .from('campaigns').select('name, cargo, city').eq('id', req.params.id).single()

    // Busca contexto recente da campanha
    const { data: recentes } = await fastify.supabase
      .from('demandas')
      .select('titulo, tipo, status')
      .eq('campaign_id', req.params.id)
      .neq('id', req.params.did)
      .order('created_at', { ascending: false })
      .limit(10)

    const modulosList = Object.entries(MODULOS)
      .map(([k, v]) => `- ${k}: ${v.label} ${v.icon}`)
      .join('\n')

    try {
      const res = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: `Você é o assistente estratégico de uma campanha eleitoral brasileira.
Analise a demanda e retorne SOMENTE JSON válido com o seguinte formato:
{
  "modulo": "<chave do módulo>",
  "confianca": <0.0 a 1.0>,
  "justificativa": "<1 frase explicando>",
  "alternativas": ["<chave1>", "<chave2>"],
  "acoes_sugeridas": ["<ação1>", "<ação2>", "<ação3>"],
  "prioridade_recomendada": "alta|media|baixa",
  "tags_sugeridas": ["<tag1>", "<tag2>"]
}
Módulos disponíveis:
${modulosList}`,
        messages: [{
          role: 'user',
          content: `Campanha: ${camp?.name || 'candidato'} (${camp?.cargo || ''} - ${camp?.city || ''})

DEMANDA:
Título: ${demanda.titulo}
Tipo declarado: ${demanda.tipo}
Descrição: ${demanda.descricao || '(sem descrição)'}
Prioridade atual: ${demanda.prioridade}

Demandas recentes da campanha (contexto):
${(recentes || []).map(d => `• [${d.tipo}] ${d.titulo} — ${d.status}`).join('\n') || '(nenhuma)'}

Qual módulo deve receber esta demanda e quais ações sugerir?`,
        }],
      })

      const raw = res.content[0].text.replace(/```json\n?|\n?```/g, '').trim()
      const parsed = JSON.parse(raw)
      const modInfo = MODULOS[parsed.modulo] || MODULOS[demanda.tipo]

      return {
        sugestao:              parsed.modulo,
        confianca:             parsed.confianca,
        justificativa:         parsed.justificativa,
        alternativas:          parsed.alternativas || [],
        acoes_sugeridas:       parsed.acoes_sugeridas || [],
        prioridade_recomendada:parsed.prioridade_recomendada,
        tags_sugeridas:        parsed.tags_sugeridas || [],
        modulo_info:           modInfo,
        gerado_ia:             true,
      }
    } catch (err) {
      // Fallback determinístico se Claude falhar
      const modulo = MODULOS[demanda.tipo] ? demanda.tipo : 'estrategia'
      return {
        sugestao:    modulo,
        confianca:   0.7,
        justificativa: `Baseado no tipo "${demanda.tipo}" da demanda.`,
        alternativas:  ['estrategia', 'ia'],
        acoes_sugeridas: [`Encaminhar para ${MODULOS[modulo]?.label || modulo}`, 'Definir responsável', 'Estabelecer prazo'],
        prioridade_recomendada: demanda.prioridade || 'media',
        tags_sugeridas: [demanda.tipo],
        modulo_info:   MODULOS[modulo],
        gerado_ia:     false,
      }
    }
  })
}
