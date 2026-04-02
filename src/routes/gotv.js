/**
 * GOTV Routes — /api/v1/campaigns/:id/gotv/*
 * Get Out The Vote — Dia da Eleição
 * CIC — Centro de Inteligência de Campanha
 */

// Eleição municipal BR: primeiro domingo de outubro de 2026
const ELEICAO = new Date('2026-10-04T06:00:00.000Z')

const CHECKLIST_PADRAO = [
  { titulo: 'Mapear todos os locais de votação', categoria: 'infraestrutura', ordem: 1 },
  { titulo: 'Recrutar e treinar fiscais de urna', categoria: 'fiscalizacao', ordem: 2 },
  { titulo: 'Organizar transporte para eleitores idosos/PcD', categoria: 'logistica', ordem: 3 },
  { titulo: 'Definir cabos eleitorais por seção', categoria: 'campo', ordem: 4 },
  { titulo: 'Preparar kit do fiscal (orientações, contatos, checklist)', categoria: 'fiscalizacao', ordem: 5 },
  { titulo: 'Criar grupo de WhatsApp por zona eleitoral', categoria: 'comunicacao', ordem: 6 },
  { titulo: 'Confirmar boca de urna com voluntários', categoria: 'campo', ordem: 7 },
  { titulo: 'Preparar sala de situação central', categoria: 'infraestrutura', ordem: 8 },
  { titulo: 'Agendar carreatas do dia anterior', categoria: 'campo', ordem: 9 },
  { titulo: 'Preparar material de comemoração/agradecimento', categoria: 'comunicacao', ordem: 10 },
  { titulo: 'Briefing geral dos líderes (D-1)', categoria: 'planejamento', ordem: 11 },
  { titulo: 'Verificar registros de eleitores (título em dia)', categoria: 'cadastro', ordem: 12 },
]

export default async function gotvRoutes(fastify) {

  // ── GET /status — dias para eleição + KPIs reais do banco ──────────────
  fastify.get('/:id/gotv/status', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const hoje = new Date()
    const diasRestantes = Math.max(0, Math.floor((ELEICAO - hoje) / 86_400_000))

    // KPIs reais em paralelo
    const [voluntarios, checklist, eleitores, agenda] = await Promise.all([
      fastify.supabase
        .from('voluntarios').select('id, status, funcao').eq('campaign_id', req.params.id),
      fastify.supabase
        .from('gotv_checklist').select('id, concluido').eq('campaign_id', req.params.id),
      fastify.supabase
        .from('eleitores').select('id, confirmado').eq('campaign_id', req.params.id),
      fastify.supabase
        .from('agenda')
        .select('id').eq('campaign_id', req.params.id)
        .gte('inicio', hoje.toISOString())
        .lte('inicio', new Date(hoje.getTime() + 30 * 86_400_000).toISOString()),
    ])

    const vols       = voluntarios.data || []
    const check      = checklist.data   || []
    const eleit      = eleitores.data   || []
    const compr      = agenda.data      || []

    // Se checklist vazio, seed automático
    if (check.length === 0) {
      await fastify.supabase.from('gotv_checklist').insert(
        CHECKLIST_PADRAO.map(item => ({ ...item, campaign_id: req.params.id, concluido: false }))
      )
    }

    const fiscais    = vols.filter(v => v.funcao?.toLowerCase().includes('fiscal'))
    const motoristas = vols.filter(v => v.funcao?.toLowerCase().includes('transport') || v.funcao?.toLowerCase().includes('motorist'))

    return {
      diasParaEleicao: diasRestantes,
      dataEleicao:     ELEICAO.toISOString(),
      progresso: {
        checklist:   { concluidos: check.filter(c => c.concluido).length, total: check.length || CHECKLIST_PADRAO.length },
        voluntarios: { ativos: vols.length, fiscais: fiscais.length, motoristas: motoristas.length },
        eleitores:   { confirmados: eleit.filter(e => e.confirmado).length, total: eleit.length },
        agenda:      { eventos_proximo_mes: compr.length },
      },
      kpis: {
        eleitoresMobilizados:  eleit.filter(e => e.confirmado).length,
        transportesOrganizados: motoristas.length,
        pontosFiscal:           fiscais.length,
        urnasFiscalizadas:      0,  // atualizado no dia da eleição
        voluntariosAtivos:      vols.length,
        percentualChecklist:    check.length > 0
          ? Math.round((check.filter(c => c.concluido).length / check.length) * 100)
          : 0,
      },
    }
  })

  // ── GET /checklist ────────────────────────────────────────────────────
  fastify.get('/:id/gotv/checklist', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('gotv_checklist').select('*')
      .eq('campaign_id', req.params.id)
      .order('ordem', { ascending: true })

    if (error) return reply.status(500).send({ error: error.message })

    // Auto-seed se vazio
    if (!data || data.length === 0) {
      const { data: seeded } = await fastify.supabase
        .from('gotv_checklist')
        .insert(CHECKLIST_PADRAO.map(item => ({ ...item, campaign_id: req.params.id, concluido: false })))
        .select()
      return { checklist: seeded || [] }
    }

    return { checklist: data }
  })

  // ── PATCH /checklist/:cid ─────────────────────────────────────────────
  fastify.patch('/:id/gotv/checklist/:cid', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { concluido, responsavel } = req.body
    const updates = { updated_at: new Date() }
    if (concluido !== undefined) updates.concluido = concluido
    if (responsavel) updates.responsavel = responsavel

    const { data, error } = await fastify.supabase
      .from('gotv_checklist')
      .update(updates)
      .eq('id', req.params.cid).eq('campaign_id', req.params.id)
      .select().single()

    if (error) return reply.status(400).send({ error: error.message })
    return { item: data }
  })

  // ── POST /checklist — adicionar item customizado ──────────────────────
  fastify.post('/:id/gotv/checklist', { preHandler: [fastify.authenticate] }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('gotv_checklist')
      .insert({ ...req.body, campaign_id: req.params.id, concluido: false })
      .select().single()
    if (error) return reply.status(400).send({ error: error.message })
    return reply.status(201).send({ item: data })
  })
}
