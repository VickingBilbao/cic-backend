/**
 * Obsidian Knowledge Graph — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Endpoints:
 *   GET    /:id/obsidian/graph       — Grafo completo { nodes, edges }
 *   GET    /:id/obsidian/node/:nid   — Detalhe de um nó
 *   POST   /:id/obsidian/nota        — Adicionar nota estratégica
 *   GET    /:id/obsidian/notas       — Listar notas
 *   DELETE /:id/obsidian/nota/:nid   — Deletar nota
 *   POST   /:id/obsidian/seed-ia     — Gerar base de conhecimento inicial com IA
 */

import Anthropic from '@anthropic-ai/sdk'
import fp from 'fastify-plugin'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

async function obsidianRoutes(fastify, opts) {
  const { supabase } = fastify

  async function getCampaign(campaignId, userId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id, org_id, name, city, state, cargo')
      .eq('id', campaignId).single()
    if (!data) return null
    const { data: profile } = await supabase
      .from('profiles').select('org_id, is_super_admin').eq('id', userId).single()
    if (!profile) return null
    if (profile.is_super_admin) return data
    if (profile.org_id !== data.org_id) return null
    return data
  }

  // ── GET /graph — grafo completo ─────────────────────────────────────────
  fastify.get('/:id/obsidian/graph', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const cid = campaign.id

    const [decisoes, swot, conteudos, segmentos, monitoramento, estrategia, notas, knowledge] =
      await Promise.all([
        // decisoes: correct column is 'contexto' (not 'descricao'), no 'tags'
        supabase.from('decisoes').select('id, titulo, contexto, created_at').eq('campaign_id', cid).limit(60),
        // swot_items: no 'tags' column
        supabase.from('swot_items').select('id, quadrante, descricao').eq('campaign_id', cid),
        supabase.from('content_items').select('id, tipo, titulo, status, tags').eq('campaign_id', cid).in('status', ['aprovado','gerado']).limit(40),
        // segmentos: no 'descricao'/'tags' columns — use 'criterios' (jsonb)
        supabase.from('segmentos').select('id, nome, criterios').eq('campaign_id', cid),
        supabase.from('monitoring_events').select('id, topicos, sentiment, resumo').eq('campaign_id', cid).not('topicos', 'is', null).limit(60),
        // timeline_estrategia: no 'fase'/'descricao'/'objetivos' — use 'semana' + 'acoes' (jsonb)
        supabase.from('timeline_estrategia').select('id, semana, acoes').eq('campaign_id', cid),
        // obsidian_notas: 'gerada_ia' added via migration 007
        supabase.from('obsidian_notas').select('id, titulo, corpo, tags, gerada_ia').eq('campaign_id', cid),
        supabase.from('knowledge_chunks').select('id, title, source, chapter, tags, tipo, relevancia, content').eq('campaign_id', cid).order('relevancia', { ascending: false }).limit(50),
      ])

    const nodes = []
    const edges = []
    let edgeId  = 0

    // Normaliza quadrante SWOT: trata plural legado (forcas→forca, etc.)
    const normalizeQ = q => {
      if (!q) return null
      const map = { forcas: 'forca', fraquezas: 'fraqueza', oportunidades: 'oportunidade', ameacas: 'ameaca' }
      return map[q] || q
    }

    // Nó central: campanha
    nodes.push({
      id: `campaign-${cid}`, label: campaign.name ?? 'Campanha',
      type: 'campanha', weight: 12, color: '#6366f1',
      meta: { cargo: campaign.cargo, cidade: campaign.city, estado: campaign.state },
    })

    // Decisões estratégicas
    ;(decisoes.data ?? []).forEach(d => nodes.push({
      id: `decisao-${d.id}`, label: d.titulo, type: 'decisao',
      weight: 5, color: '#f59e0b', tags: [],
      meta: { descricao: d.contexto, data: d.created_at },
    }))

    // SWOT
    const swotColors = { forca: '#10b981', fraqueza: '#ef4444', oportunidade: '#3b82f6', ameaca: '#f97316' }
    ;(swot.data ?? []).forEach(s => {
      const q = normalizeQ(s.quadrante)
      if (!q) return // skip rows with null quadrante
      nodes.push({
        id: `swot-${s.id}`,
        label: (s.descricao ?? '').slice(0, 55) + ((s.descricao?.length ?? 0) > 55 ? '…' : ''),
        type: `swot_${q}`, weight: 3,
        color: swotColors[q] ?? '#94a3b8', tags: [],
      })
    })

    // Conteúdos aprovados
    ;(conteudos.data ?? []).forEach(c => nodes.push({
      id: `conteudo-${c.id}`, label: c.titulo ?? c.tipo, type: 'conteudo',
      weight: 2, color: '#8b5cf6', tags: c.tags ?? [],
      meta: { tipo: c.tipo, status: c.status },
    }))

    // Segmentos eleitorais — criterios is jsonb { descricao, prioridade, tamanho, tags }
    ;(segmentos.data ?? []).forEach(s => nodes.push({
      id: `segmento-${s.id}`, label: s.nome, type: 'segmento',
      weight: 4, color: '#06b6d4', tags: s.criterios?.tags ?? [],
      meta: { descricao: s.criterios?.descricao, prioridade: s.criterios?.prioridade },
    }))

    // Tópicos de monitoramento (agrupados)
    const topicMap = {}
    ;(monitoramento.data ?? []).forEach(e => {
      ;(e.topicos ?? []).forEach(t => {
        if (!topicMap[t]) topicMap[t] = { count: 0, sentimentos: [] }
        topicMap[t].count++
        topicMap[t].sentimentos.push(e.sentiment)
      })
    })
    Object.entries(topicMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 25)
      .forEach(([topic, data]) => {
        const neg = data.sentimentos.filter(s => s === 'negative').length
        const pos = data.sentimentos.filter(s => s === 'positive').length
        nodes.push({
          id: `topico-${topic.replace(/\s+/g, '_')}`, label: topic,
          type: 'topico_monitoramento',
          weight: Math.min(Math.ceil(data.count / 2) + 1, 9),
          color: neg > pos ? '#ef4444' : pos > neg ? '#10b981' : '#94a3b8',
          meta: { count: data.count, negativos: neg, positivos: pos },
        })
      })

    // Timeline estratégica — acoes is jsonb { fase, descricao, objetivos, periodo }
    ;(estrategia.data ?? []).forEach(e => nodes.push({
      id: `estrategia-${e.id}`, label: e.acoes?.fase ?? `Fase ${e.semana}`, type: 'estrategia',
      weight: 6, color: '#ec4899',
      meta: { descricao: e.acoes?.descricao, objetivos: e.acoes?.objetivos, periodo: e.acoes?.periodo },
    }))

    // Notas estratégicas (manuais + IA)
    ;(notas.data ?? []).forEach(n => nodes.push({
      id: `nota-${n.id}`, label: n.titulo, type: n.gerada_ia ? 'nota_ia' : 'nota',
      weight: n.gerada_ia ? 3 : 2, color: n.gerada_ia ? '#c084fc' : '#a78bfa',
      tags: n.tags ?? [],
      meta: { corpo: n.corpo?.slice(0, 200) },
    }))

    // Knowledge chunks (base de conhecimento)
    ;(knowledge.data ?? []).forEach(k => nodes.push({
      id: `knowledge-${k.id}`,
      label: k.title || k.chapter || k.source,
      type: 'conhecimento',
      weight: Math.min((k.relevancia ?? 5), 8),
      color: '#34d399',
      tags: k.tags ?? [],
      meta: { source: k.source, chapter: k.chapter, tipo: k.tipo, preview: k.content?.slice(0, 150) },
    }))

    // ── Edges ─────────────────────────────────────────────────────────────

    // Todos conectam ao hub central
    nodes.slice(1).forEach(n => {
      edges.push({ id: `e-${edgeId++}`, source: `campaign-${cid}`, target: n.id, weight: 1, type: 'pertence' })
    })

    // Conexões por tags compartilhadas
    const tagIndex = {}
    nodes.forEach(n => {
      ;(n.tags ?? []).forEach(tag => {
        if (!tagIndex[tag]) tagIndex[tag] = []
        tagIndex[tag].push(n.id)
      })
    })
    Object.entries(tagIndex).forEach(([tag, nodeIds]) => {
      if (nodeIds.length < 2) return
      for (let i = 0; i < nodeIds.length; i++) {
        for (let j = i + 1; j < nodeIds.length && j < i + 4; j++) {
          const src = nodeIds[i], tgt = nodeIds[j]
          if (src === `campaign-${cid}` || tgt === `campaign-${cid}`) continue
          const already = edges.find(e =>
            (e.source === src && e.target === tgt) || (e.source === tgt && e.target === src)
          )
          if (!already) {
            edges.push({ id: `e-${edgeId++}`, source: src, target: tgt, weight: 1, type: 'relacionado', label: tag })
          }
        }
      }
    })

    // SWOT → estratégia (forças/oportunidades conectam a fases)
    ;(swot.data ?? []).filter(s => ['forca','oportunidade'].includes(normalizeQ(s.quadrante))).forEach(s => {
      ;(estrategia.data ?? []).slice(0, 2).forEach(e => {
        edges.push({ id: `e-${edgeId++}`, source: `swot-${s.id}`, target: `estrategia-${e.id}`, weight: 2, type: 'fundamenta' })
      })
    })

    // Tópicos monitoramento → decisões (conexão contexto→decisão)
    ;(decisoes.data ?? []).slice(0, 5).forEach(d => {
      const titulo = d.titulo?.toLowerCase() ?? ''
      nodes.filter(n => n.type === 'topico_monitoramento').forEach(t => {
        if (titulo.includes(t.label?.toLowerCase()?.slice(0, 6) ?? '___')) {
          edges.push({ id: `e-${edgeId++}`, source: `decisao-${d.id}`, target: t.id, weight: 2, type: 'embasado_em' })
        }
      })
    })

    // Knowledge → segmentos (base de conhecimento informa segmentos)
    ;(knowledge.data ?? []).slice(0, 10).forEach(k => {
      ;(segmentos.data ?? []).slice(0, 3).forEach(s => {
        edges.push({ id: `e-${edgeId++}`, source: `knowledge-${k.id}`, target: `segmento-${s.id}`, weight: 1, type: 'referencia' })
      })
    })

    return {
      nodes,
      edges: edges.slice(0, 500), // cap para performance
      meta: {
        totalNodes: nodes.length,
        totalEdges: Math.min(edges.length, 500),
        geradoEm:   new Date().toISOString(),
        campanha:   { nome: campaign.name, cidade: campaign.city, cargo: campaign.cargo },
      },
    }
  })

  // ── GET /node/:nodeId ───────────────────────────────────────────────────
  fastify.get('/:id/obsidian/node/:nodeId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const parts = request.params.nodeId.split('-')
    const type  = parts[0]
    const rawId = parts.slice(1).join('-')

    const TABLE_MAP = {
      decisao:    'decisoes',
      swot:       'swot_items',
      conteudo:   'content_items',
      segmento:   'segmentos',
      estrategia: 'timeline_estrategia',
      nota:       'obsidian_notas',
      nota_ia:    'obsidian_notas',
      knowledge:  'knowledge_chunks',
    }

    const table = TABLE_MAP[type]
    if (!table) return reply.status(404).send({ error: 'Tipo de nó não reconhecido' })

    const { data, error } = await supabase.from(table).select('*').eq('id', rawId).single()
    if (error || !data) return reply.status(404).send({ error: 'Nó não encontrado' })
    return data
  })

  // ── POST /nota ──────────────────────────────────────────────────────────
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
      .insert({ campaign_id: campaign.id, ...request.body, tags: request.body.tags ?? [], gerada_ia: false })
      .select('id').single()

    if (error) return reply.status(500).send({ error: error.message })
    return reply.status(201).send({ id: data.id })
  })

  // ── GET /notas ──────────────────────────────────────────────────────────
  fastify.get('/:id/obsidian/notas', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data, error } = await supabase
      .from('obsidian_notas')
      .select('*').eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { notas: data }
  })

  // ── DELETE /nota/:id ────────────────────────────────────────────────────
  fastify.delete('/:id/obsidian/nota/:notaId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    await supabase.from('obsidian_notas').delete()
      .eq('id', request.params.notaId).eq('campaign_id', campaign.id)

    return reply.status(204).send()
  })

  // ── POST /seed-ia — Claude gera base de conhecimento inicial ────────────
  // Cria SWOT, segmentos, decisões, timeline e notas estratégicas a partir
  // do perfil da campanha. Ideal para demo ou onboarding de novo marketeiro.
  fastify.post('/:id/obsidian/seed-ia', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const cid = campaign.id

    // ?force=true permite re-seed mesmo com dados existentes (limpa e regera)
    const forceReseed = request.query?.force === 'true'

    const { count: existente } = await supabase
      .from('obsidian_notas')
      .select('id', { count: 'exact', head: true })
      .eq('campaign_id', cid)
      .eq('gerada_ia', true)

    if ((existente || 0) > 3 && !forceReseed) {
      return { mensagem: 'Base de conhecimento já populada', pulado: true }
    }

    // force=true: apaga notas_ia e knowledge_chunks anteriores para regenerar limpo
    if (forceReseed && (existente || 0) > 0) {
      await supabase.from('obsidian_notas').delete().eq('campaign_id', cid).eq('gerada_ia', true)
      await supabase.from('knowledge_chunks').delete().eq('campaign_id', cid)
      console.log(`[obsidian seed-ia] force-reseed: limpando dados anteriores da campanha ${cid}`)
    }

    reply.status(202).send({ mensagem: 'Gerando base de conhecimento com IA. Aguarde 15-30s e recarregue o grafo.' })

    // Geração assíncrona após retornar 202
    setImmediate(async () => {
      try {
        const nome   = campaign.name
        const cargo  = campaign.cargo  || 'vereador'
        const cidade = campaign.city   || 'cidade'
        const estado = campaign.state  || 'SP'
        const partido = campaign.partido || 'partido'
        const numero  = campaign.numero_urna || '00000'

        // Busca nome do marketeiro para personalizar os prompts
        const { data: marketerProfile } = await supabase
          .from('profiles').select('name').eq('id', request.user.sub).single()
        const marketerName = marketerProfile?.name || 'o marketeiro'

        // ── 1. Gera SWOT completo ──────────────────────────────────────────
        try {
          const swotRes = await anthropic.messages.create({
            model:      'claude-sonnet-4-6',
            max_tokens: 2000,
            system: `Você é um estrategista político especializado em campanhas brasileiras.
Retorne SOMENTE JSON válido. Sem markdown.`,
            messages: [{
              role: 'user',
              content: `Campanha: ${nome} | ${cargo} | ${cidade}-${estado}

Gere análise SWOT. JSON:
{"forcas":[{"descricao":"..."}],"fraquezas":[{"descricao":"..."}],"oportunidades":[{"descricao":"..."}],"ameacas":[{"descricao":"..."}]}
4 forças, 3 fraquezas, 4 oportunidades, 3 ameaças. Contexto ${cargo} Brasil 2026.`,
            }],
          })
          const swotData = JSON.parse(swotRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
          const swotItems = [
            ...(swotData.forcas || []).map(f => ({ ...f, quadrante: 'forca' })),
            ...(swotData.fraquezas || []).map(f => ({ ...f, quadrante: 'fraqueza' })),
            ...(swotData.oportunidades || []).map(f => ({ ...f, quadrante: 'oportunidade' })),
            ...(swotData.ameacas || []).map(f => ({ ...f, quadrante: 'ameaca' })),
          ]
          if (swotItems.length) {
            const { error: sErr } = await supabase.from('swot_items').insert(
              swotItems.map(s => ({ campaign_id: cid, quadrante: s.quadrante, descricao: s.descricao, peso: 5 }))
            )
            if (sErr) console.error('[seed-ia] swot insert error:', sErr.message)
            else console.log(`[seed-ia] swot inserido: ${swotItems.length} itens`)
          }
        } catch (e) { console.error('[seed-ia] step 1 SWOT erro:', e.message) }

        // ── 2. Gera segmentos eleitorais ───────────────────────────────────
        try {
          const segRes = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 1200,
            system: 'Retorne SOMENTE JSON válido.',
            messages: [{
              role: 'user',
              content: `Campanha: ${nome} | ${cargo} | ${cidade}-${estado}

5 segmentos eleitorais. JSON:
[{"nome":"...","descricao":"...","tamanho_estimado":"...","prioridade":"alta|media|baixa","tags":["..."]}]`,
            }],
          })
          const segData = JSON.parse(segRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
          if (Array.isArray(segData)) {
            const { error: sgErr } = await supabase.from('segmentos').insert(
              segData.map(s => ({
                campaign_id: cid, nome: s.nome,
                criterios:   { descricao: s.descricao, prioridade: s.prioridade, tamanho: s.tamanho_estimado, tags: s.tags || [] },
                total_eleitores: 0,
              }))
            )
            if (sgErr) console.error('[seed-ia] segmentos insert error:', sgErr.message)
            else console.log(`[seed-ia] segmentos inseridos: ${segData.length}`)
          }
        } catch (e) { console.error('[seed-ia] step 2 segmentos erro:', e.message) }

        // ── 3. Gera timeline estratégica ───────────────────────────────────
        try {
          const timeRes = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 1500,
            system: 'Retorne SOMENTE JSON válido.',
            messages: [{
              role: 'user',
              content: `Campanha: ${nome} | ${cargo} | Eleição: outubro/2026

4 fases da campanha. JSON:
[{"fase":"...","descricao":"...","objetivos":["...","..."],"periodo":"..."}]
Fases: Construção de base → Expansão → Intensificação → Reta final.`,
            }],
          })
          const timeData = JSON.parse(timeRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
          if (Array.isArray(timeData)) {
            const { error: tErr } = await supabase.from('timeline_estrategia').insert(
              timeData.map((t, i) => ({
                campaign_id: cid, semana: (i + 1) * 10,
                acoes: { fase: t.fase, descricao: t.descricao, objetivos: t.objetivos || [], periodo: t.periodo },
              }))
            )
            if (tErr) console.error('[seed-ia] timeline insert error:', tErr.message)
            else console.log(`[seed-ia] timeline inserida: ${timeData.length} fases`)
          }
        } catch (e) { console.error('[seed-ia] step 3 timeline erro:', e.message) }

        // ── 4. Notas do segundo cérebro — como o marketeiro pensa nesta campanha ──
        // Framing: insights pessoais do marketeiro aplicados a esta campanha,
        // não análise genérica. Voz: primeira pessoa / perspectiva profissional.
        const notasRes = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 5000,
          system: `Você está construindo o segundo cérebro de ${marketerName}, especialista em marketing político brasileiro.
Sua tarefa: gerar anotações que capturem o raciocínio, diagnóstico e intuição profissional deste marketeiro.
Escreva como se fossem notas pessoais do profissional — o que ele observa, como ele interpreta, que padrão ele reconhece.
Retorne SOMENTE JSON válido. Sem markdown. Corpo: máx 150 palavras por nota.`,
          messages: [{
            role: 'user',
            content: `Campanha: ${nome} | ${cargo} | ${cidade}-${estado} | ${partido}

Gere 8 notas que representam como ${marketerName} pensa sobre esta campanha.
Cada nota deve soar como um insight do próprio marketeiro — específico, profissional, com seu ponto de vista.

JSON: [{"titulo":"...","corpo":"...","tags":["...","...","..."]}]

Ângulos obrigatórios (um por nota):
1. Leitura do território: o que este cidade/região tem de específico que muda a estratégia
2. Diagnóstico do eleitorado: quem de fato decide esta eleição e por quê
3. Posicionamento central: a aposta de comunicação que vai diferenciar este candidato
4. Risco principal que vejo: o que pode fazer essa campanha perder
5. Oportunidade que poucos estão enxergando neste contexto
6. Como vou trabalhar presença digital aqui (não genérico — específico para este perfil)
7. Segmento prioritário e por que aposto nele
8. Padrão que reconheço: algo que já vi funcionar em campanhas similares e vou aplicar aqui`,
          }],
        })

        try {
          const notasData = JSON.parse(notasRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
          if (Array.isArray(notasData)) {
            const { error: nErr } = await supabase.from('obsidian_notas').insert(
              notasData.map(n => ({
                campaign_id: cid,
                titulo: n.titulo,
                corpo: n.corpo,
                tags: n.tags || [],
                gerada_ia: true,
              }))
            )
            if (nErr) console.error('[obsidian seed-ia] notas insert error:', nErr.message)
            else console.log(`[obsidian seed-ia] notas inseridas: ${notasData.length}`)
          }
        } catch (parseErr) {
          console.error('[obsidian seed-ia] notas JSON parse error:', parseErr.message)
        }

        // ── 5. Knowledge chunks — frameworks e modelos mentais do marketeiro ──
        // CRUCIAL: estes não são dados da campanha — são o CONHECIMENTO que o
        // marketeiro traz para qualquer campanha. A expertise acumulada dele.
        const knowledgeRes = await anthropic.messages.create({
          model:      'claude-sonnet-4-6',
          max_tokens: 5000,
          system: `Você está mapeando a inteligência de mercado de ${marketerName}, especialista em marketing político brasileiro.
Sua tarefa: extrair os frameworks, modelos mentais e metodologias que este profissional domina.
IMPORTANTE: não analise a campanha — mapeie o CONHECIMENTO que o profissional traz para qualquer campanha.
Cada chunk é um conceito que vive na cabeça do marketeiro, independente de qual candidato está trabalhando.
Retorne SOMENTE JSON válido. Conteúdo conciso e denso (máx 200 palavras cada).`,
          messages: [{
            role: 'user',
            content: `Contexto de atuação: ${marketerName} trabalha com ${cargo} em cidades como ${cidade}-${estado}.

Gere 6 nós de conhecimento que representam a inteligência acumulada deste marketeiro.
Pense: o que um profissional experiente em campanhas deste perfil TEM NA CABEÇA que o diferencia?

JSON: [{"title":"...","source":"Inteligência ${marketerName}","chapter":1,"content":"...","tags":["..."],"tipo":"framework|metodologia|diagnostico|experiencia","relevancia":8}]

Domínios obrigatórios (um por chunk):
1. Framework de diagnóstico de eleitorado: como lê rapidamente um mercado eleitoral novo
2. Modelo de posicionamento: como decide a aposta de comunicação de um candidato
3. Metodologia de segmentação: como identifica e prioriza grupos de eleitores
4. Gestão de crise eleitoral: como age quando a campanha entra em turbulência
5. Inteligência competitiva: como analisa adversários e antecipa movimentos
6. Lições de campanhas anteriores: padrões aprendidos que informam decisões

IMPORTANTE: "chapter" número inteiro (1-6). "relevancia" número inteiro (1-10).`,
          }],
        })

        let knowledgeData
        try {
          knowledgeData = JSON.parse(knowledgeRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
        } catch (parseErr) {
          console.error('[obsidian seed-ia] knowledge_chunks JSON parse error:', parseErr.message)
          knowledgeData = []
        }
        if (Array.isArray(knowledgeData) && knowledgeData.length > 0) {
          const { error: kErr } = await supabase.from('knowledge_chunks').insert(
            knowledgeData.map((k, i) => ({
              campaign_id: cid,
              title:       k.title,
              source:      k.source || 'Estratégia Política Brasileira',
              chapter:     parseInt(k.chapter) || (i + 1), // chapter must be integer
              content:     k.content,
              tags:        Array.isArray(k.tags) ? k.tags : [],
              tipo:        k.tipo || 'estrategia',
              relevancia:  parseInt(k.relevancia) || 7,
            }))
          )
          if (kErr) console.error('[obsidian seed-ia] knowledge_chunks insert error:', kErr.message, kErr.details)
          else console.log(`[obsidian seed-ia] knowledge_chunks inseridos: ${knowledgeData.length}`)
        }

        // ── 6. Gera decisões estratégicas iniciais ─────────────────────────
        try {
          const decisoesRes = await anthropic.messages.create({
            model:      'claude-haiku-4-5-20251001',
            max_tokens: 1200,
            system: 'Retorne SOMENTE JSON válido.',
            messages: [{
              role: 'user',
              content: `Campanha: ${nome} | ${cargo} | ${cidade}-${estado}

5 decisões estratégicas aprovadas. JSON:
[{"titulo":"...","descricao":"...","status":"aprovada"}]
Sobre: posicionamento, tom, foco geográfico, coligações, pauta.`,
            }],
          })
          const decisoesData = JSON.parse(decisoesRes.content[0].text.replace(/```json\n?|\n?```/g, '').trim())
          if (Array.isArray(decisoesData)) {
            const { error: dErr } = await supabase.from('decisoes').insert(
              decisoesData.map(d => ({
                campaign_id:     cid,
                titulo:          d.titulo,
                contexto:        d.descricao || d.contexto || '',
                recomendacao_ia: d.recomendacao || d.recomendacao_ia || d.descricao || '',
                status:          'aprovada',
              }))
            )
            if (dErr) console.error('[seed-ia] decisoes insert error:', dErr.message)
            else console.log(`[seed-ia] decisoes inseridas: ${decisoesData.length}`)
          }
        } catch (e) { console.error('[seed-ia] step 6 decisoes erro:', e.message) }

        console.log(`[obsidian seed-ia] Campanha ${cid} — seed concluído`)
      } catch (err) {
        console.error('[obsidian seed-ia] Erro na geração:', err.message)
      }
    })
  })
}

export default obsidianRoutes
