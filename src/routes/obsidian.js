/**
 * Obsidian Knowledge Graph — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Serves graph data for D3.js visualisation in the frontend.
 * The graph represents the campaign's strategic knowledge base:
 *   - Nodes: decisoes, swot_items, estrategia, content_items, monitoring themes, eleitores segments
 *   - Edges: thematic relationships derived from shared topics/tags
 *
 * Endpoints:
 *   GET /campaigns/:id/obsidian/graph     — Full graph { nodes, edges }
 *   GET /campaigns/:id/obsidian/node/:id  — Detail for a single node
 *   POST /campaigns/:id/obsidian/nota     — Add a free-form strategic note
 *   GET /campaigns/:id/obsidian/notas     — List strategic notes
 *   DELETE /campaigns/:id/obsidian/nota/:notaId — Delete a nota
 */

import fp from 'fastify-plugin'

async function obsidianRoutes(fastify, opts) {
  const { supabase } = fastify

  async function getCampaign(campaignId, userId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id, org_id, name, city')
      .eq('id', campaignId).single()
    if (!data) return null
    const { data: profile } = await supabase
      .from('profiles').select('org_id').eq('id', userId).single()
    if (!profile || profile.org_id !== data.org_id) return null
    return data
  }

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/obsidian/graph — full graph for D3.js
  // -------------------------------------------------------------------------
  fastify.get('/:id/obsidian/graph', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const cid = campaign.id

    // Fetch data in parallel from multiple tables
    const [decisoes, swot, conteudos, segmentos, monitoramento, estrategia, notas] =
      await Promise.all([
        supabase.from('decisoes').select('id, titulo, descricao, tags, created_at').eq('campaign_id', cid).limit(50),
        supabase.from('swot_items').select('id, quadrante, descricao, tags').eq('campaign_id', cid),
        supabase.from('content_items').select('id, tipo, titulo, status, tags').eq('campaign_id', cid).eq('status', 'aprovado').limit(30),
        supabase.from('segmentos').select('id, nome, descricao, tags').eq('campaign_id', cid),
        supabase.from('monitoring_events').select('id, topicos, sentimento, resumo').eq('campaign_id', cid).not('topicos', 'is', null).limit(50),
        supabase.from('timeline_estrategia').select('id, fase, descricao, objetivos').eq('campaign_id', cid),
        supabase.from('obsidian_notas').select('id, titulo, corpo, tags').eq('campaign_id', cid),
      ])

    // Build nodes
    const nodes = []

    // Campaign itself as central node
    nodes.push({ id: `campaign-${cid}`, label: campaign.name ?? 'Campanha',
      type: 'campanha', weight: 10, color: '#6366f1' })

    ;(decisoes.data ?? []).forEach(d => nodes.push({
      id: `decisao-${d.id}`, label: d.titulo, type: 'decisao',
      weight: 4, color: '#f59e0b', tags: d.tags ?? [], meta: { descricao: d.descricao },
    }))

    ;(swot.data ?? []).forEach(s => {
      const colors = { forca: '#10b981', fraqueza: '#ef4444', oportunidade: '#3b82f6', ameaca: '#f97316' }
      nodes.push({ id: `swot-${s.id}`, label: s.descricao?.slice(0, 60),
        type: `swot_${s.quadrante}`, weight: 3, color: colors[s.quadrante] ?? '#94a3b8', tags: s.tags ?? [] })
    })

    ;(conteudos.data ?? []).forEach(c => nodes.push({
      id: `conteudo-${c.id}`, label: c.titulo ?? c.tipo, type: 'conteudo',
      weight: 2, color: '#8b5cf6', tags: c.tags ?? [], meta: { tipo: c.tipo, status: c.status },
    }))

    ;(segmentos.data ?? []).forEach(s => nodes.push({
      id: `segmento-${s.id}`, label: s.nome, type: 'segmento',
      weight: 3, color: '#06b6d4', tags: s.tags ?? [], meta: { descricao: s.descricao },
    }))

    // Collapse monitoring events into topic nodes
    const topicMap = {}
    ;(monitoramento.data ?? []).forEach(e => {
      ;(e.topicos ?? []).forEach(t => {
        if (!topicMap[t]) topicMap[t] = { count: 0, sentimentos: [] }
        topicMap[t].count++
        topicMap[t].sentimentos.push(e.sentimento)
      })
    })
    Object.entries(topicMap).slice(0, 20).forEach(([topic, data]) => {
      const neg = data.sentimentos.filter(s => s === 'negativo').length
      const pos = data.sentimentos.filter(s => s === 'positivo').length
      nodes.push({ id: `topico-${topic}`, label: topic, type: 'topico_monitoramento',
        weight: Math.min(data.count, 8), color: neg > pos ? '#ef4444' : '#10b981',
        meta: { count: data.count, negativos: neg, positivos: pos },
      })
    })

    ;(estrategia.data ?? []).forEach(e => nodes.push({
      id: `estrategia-${e.id}`, label: e.fase, type: 'estrategia',
      weight: 5, color: '#ec4899', tags: [], meta: { descricao: e.descricao, objetivos: e.objetivos },
    }))

    ;(notas.data ?? []).forEach(n => nodes.push({
      id: `nota-${n.id}`, label: n.titulo, type: 'nota',
      weight: 2, color: '#a78bfa', tags: n.tags ?? [],
    }))

    // Build edges (connections between nodes)
    const edges = []
    let edgeId = 0

    // All nodes connect to campaign hub
    nodes.slice(1).forEach(n => {
      edges.push({ id: `e-${edgeId++}`, source: `campaign-${cid}`, target: n.id,
        weight: 1, type: 'pertence' })
    })

    // Connect nodes that share tags
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j]
        if (!a.tags?.length || !b.tags?.length) continue
        const shared = a.tags.filter(t => b.tags.includes(t))
        if (shared.length > 0) {
          edges.push({ id: `e-${edgeId++}`, source: a.id, target: b.id,
            weight: shared.length, type: 'relacionado', label: shared[0] })
        }
      }
    }

    // Connect monitoring topics to matching strategy elements
    ;(estrategia.data ?? []).forEach(e => {
      ;(e.objetivos ?? []).forEach(obj => {
        const matchingTopic = nodes.find(n =>
          n.type === 'topico_monitoramento' && n.label.toLowerCase().includes(obj.toLowerCase().slice(0, 8))
        )
        if (matchingTopic) {
          edges.push({ id: `e-${edgeId++}`, source: `estrategia-${e.id}`,
            target: matchingTopic.id, weight: 2, type: 'monitorado' })
        }
      })
    })

    return {
      nodes,
      edges,
      meta: {
        totalNodes: nodes.length,
        totalEdges: edges.length,
        geradoEm: new Date().toISOString(),
      },
    }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/obsidian/node/:nodeId — full detail for one node
  // -------------------------------------------------------------------------
  fastify.get('/:id/obsidian/node/:nodeId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const [type, rawId] = request.params.nodeId.split('-').reduce(
      (acc, part, i) => i === 0 ? [part, ''] : [acc[0], acc[1] ? `${acc[1]}-${part}` : part],
      ['', '']
    )

    const TABLE_MAP = {
      decisao: 'decisoes', swot: 'swot_items', conteudo: 'content_items',
      segmento: 'segmentos', estrategia: 'timeline_estrategia', nota: 'obsidian_notas',
    }

    const table = TABLE_MAP[type]
    if (!table) return reply.status(404).send({ error: 'Tipo de nó não reconhecido' })

    const { data, error } = await supabase
      .from(table).select('*').eq('id', rawId).single()

    if (error || !data) return reply.status(404).send({ error: 'Nó não encontrado' })
    return data
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/obsidian/nota — add a strategic note
  // -------------------------------------------------------------------------
  fastify.post('/:id/obsidian/nota', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object', required: ['titulo', 'corpo'],
        properties: {
          titulo: { type: 'string', maxLength: 200 },
          corpo:  { type: 'string' },
          tags:   { type: 'array', items: { type: 'string' } },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('obsidian_notas')
      .insert({ campaign_id: campaign.id, ...request.body, tags: request.body.tags ?? [] })
      .select('id').single()

    if (error) return reply.status(500).send({ error: error.message })
    return reply.status(201).send({ id: data.id })
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/obsidian/notas — list strategic notes
  // -------------------------------------------------------------------------
  fastify.get('/:id/obsidian/notas', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('obsidian_notas')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { notas: data }
  })

  // -------------------------------------------------------------------------
  // DELETE /campaigns/:id/obsidian/nota/:notaId
  // -------------------------------------------------------------------------
  fastify.delete('/:id/obsidian/nota/:notaId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    await supabase.from('obsidian_notas')
      .delete()
      .eq('id', request.params.notaId)
      .eq('campaign_id', campaign.id)

    return reply.status(204).send()
  })
}

export default obsidianRoutes
