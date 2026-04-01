// ── /api/v1/campaigns/:id/demandas ───────────────────────────
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
          prazo:      { type: 'string', format: 'date' }
        }
      }
    }
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('demandas')
      .insert({
        ...req.body,
        campaign_id: req.params.id,
        criado_por:  req.user.id,
        status:      'nova'
      })
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ demanda: data })
  })

  // PATCH /campaigns/:id/demandas/:did/status
  fastify.patch('/:id/demandas/:did/status', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { status } = req.body
    const validStatus = ['nova', 'em_andamento', 'concluida', 'cancelada']
    if (!validStatus.includes(status)) {
      return reply.status(400).send({ error: 'Status inválido' })
    }
    const { data, error } = await fastify.supabase
      .from('demandas')
      .update({ status, updated_at: new Date() })
      .eq('id', req.params.did)
      .eq('campaign_id', req.params.id)
      .select()
      .single()

    if (error) return reply.status(400).send({ error: error.message })
    return { demanda: data }
  })

  // POST /campaigns/:id/demandas/:did/ai-suggest — IA sugere destinos
  fastify.post('/:id/demandas/:did/ai-suggest', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data: demanda } = await fastify.supabase
      .from('demandas').select('*').eq('id', req.params.did).single()
    if (!demanda) return reply.status(404).send({ error: 'Demanda não encontrada' })

    // Lógica simples de classificação (expandir com Claude na Semana 2)
    const destinos = {
      roteiro:      'producao',
      comunicacao:  'comunicacao',
      estrategia:   'estrategia',
      monitoramento:'monitoramento',
      social:       'social',
      voluntarios:  'voluntarios',
      agenda:       'agenda',
      producao:     'producao'
    }

    return {
      sugestao: destinos[demanda.tipo] || 'assistente_ia',
      confianca: 0.85,
      alternativas: ['assistente_ia', 'estrategia']
    }
  })
}
