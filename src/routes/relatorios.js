/**
 * CIC — Relatórios
 * Gera relatórios estratégicos reais usando Claude + dados da campanha
 * SSE streaming para relatórios longos
 */

import { generate } from '../services/claude.js'

const RELATORIO_PROMPTS = {
  estrategia: (c, data) => `
Você é o Agente FC. Gere um RELATÓRIO ESTRATÉGICO completo para a campanha de ${c.name} (${c.cargo}, ${c.city}/${c.state}).

DADOS DISPONÍVEIS:
${JSON.stringify(data, null, 2)}

O relatório deve conter:
1. DIAGNÓSTICO ATUAL — onde a campanha está hoje
2. ANÁLISE DE SENTIMENTO — percepção pública nos últimos 30 dias
3. PRODUÇÃO DE CONTEÚDO — o que foi gerado, aprovado, rejeitado
4. DEMANDAS — status das solicitações em aberto
5. RECOMENDAÇÕES — 3 ações prioritárias para os próximos 15 dias

Formato: texto corrido, sem bullet points excessivos. Tom FC+.
`,
  monitoramento: (c, data) => `
Gere um RELATÓRIO DE MONITORAMENTO para ${c.name} (${c.cargo}, ${c.city}).

EVENTOS MONITORADOS:
${JSON.stringify(data.eventos || [], null, 2)}

ESTATÍSTICAS:
${JSON.stringify(data.stats || {}, null, 2)}

O relatório deve:
1. Identificar os temas dominantes na cobertura pública
2. Analisar o sentimento geral (positivo/negativo/neutro)
3. Destacar alertas e riscos identificados
4. Recomendar respostas específicas para os pontos negativos
5. Mapear oportunidades de comunicação

Tom: analítico, direto. Máximo 800 palavras.
`,
  conteudo: (c, data) => `
Gere um RELATÓRIO DE PRODUÇÃO DE CONTEÚDO para ${c.name}.

CONTEÚDOS PRODUZIDOS:
${JSON.stringify(data.conteudos || [], null, 2)}

O relatório deve:
1. Resumir o volume de produção por agente e tipo
2. Analisar taxa de aprovação
3. Identificar padrões nos conteúdos rejeitados
4. Recomendar ajustes no fluxo de produção
`,
  completo: (c, data) => `
Gere um RELATÓRIO EXECUTIVO COMPLETO da campanha ${c.name} (${c.cargo}, ${c.city}/${c.state}).

DADOS COMPLETOS DA CAMPANHA:
${JSON.stringify(data, null, 2)}

O relatório executivo deve cobrir:
1. VISÃO GERAL — estado atual da campanha em 2 parágrafos
2. INDICADORES-CHAVE — principais métricas e o que significam
3. PONTOS FORTES — o que está funcionando
4. RISCOS IDENTIFICADOS — o que precisa de atenção imediata
5. AGENDA DE AÇÕES — próximos 30 dias, com datas e responsáveis sugeridos

Extensão: 600-900 palavras. Tom FC+.
`
}

export default async function relatoriosRoutes(fastify) {

  // POST /campaigns/:id/relatorios/gerar — gera relatório com Claude
  fastify.post('/:id/relatorios/gerar', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { tipo = 'estrategia', params: relParams = {} } = req.body
    const cid = req.params.id

    // Busca dados da campanha
    const { data: campaign } = await fastify.supabase
      .from('campaigns').select('*').eq('id', cid).single()
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    // Coleta dados relevantes conforme tipo do relatório
    let reportData = {}

    const [monRes, contentRes, demandasRes, pesquisaRes, iaRes] = await Promise.all([
      fastify.supabase.from('monitoring_events')
        .select('platform, sentiment, content, topicos, resumo, urgente, created_at')
        .eq('campaign_id', cid).order('created_at', { ascending: false }).limit(50),
      fastify.supabase.from('content_items')
        .select('type, agent, status, created_at')
        .eq('campaign_id', cid).order('created_at', { ascending: false }).limit(30),
      fastify.supabase.from('demandas')
        .select('titulo, tipo, status, prioridade, created_at')
        .eq('campaign_id', cid).order('created_at', { ascending: false }).limit(20),
      fastify.supabase.from('pesquisas_eleitorais')
        .select('intencao_voto, rejeicao, data')
        .eq('campaign_id', cid).order('data', { ascending: false }).limit(3),
      fastify.supabase.from('ia_historico')
        .select('agente, pergunta, created_at')
        .eq('campaign_id', cid).order('created_at', { ascending: false }).limit(10)
    ])

    reportData = {
      eventos:   monRes.data    || [],
      conteudos: contentRes.data || [],
      demandas:  demandasRes.data || [],
      pesquisas: pesquisaRes.data || [],
      interacoesIA: iaRes.data  || [],
      stats: {
        totalEventos:   (monRes.data || []).length,
        positivos:      (monRes.data || []).filter(e => e.sentiment === 'positivo').length,
        negativos:      (monRes.data || []).filter(e => e.sentiment === 'negativo').length,
        urgentes:       (monRes.data || []).filter(e => e.urgente).length,
        conteudosAprov: (contentRes.data || []).filter(c => c.status === 'approved').length,
        demandasAbertas:(demandasRes.data || []).filter(d => d.status !== 'concluida').length,
      }
    }

    // Cria registro inicial no banco
    const { data: relatorio, error: insertErr } = await fastify.supabase
      .from('relatorios')
      .insert({
        campaign_id: cid,
        tipo,
        status:      'gerando',
        gerado_por:  req.user.id,
        params:      relParams,
        url:         null
      })
      .select()
      .single()

    if (insertErr) return reply.status(500).send({ error: insertErr.message })

    // Gera relatório com Claude (assíncrono — não bloqueia o response)
    const buildPromptFn = RELATORIO_PROMPTS[tipo] || RELATORIO_PROMPTS.estrategia
    const promptText    = buildPromptFn(campaign, reportData)

    // Executa geração em background
    ;(async () => {
      try {
        const { text } = await generate({
          supabase:  fastify.supabase,
          campaign,
          prompt:    promptText,
          agente:    'relatorios',
          maxTokens: 3000
        })

        // Monta HTML simples do relatório
        const htmlContent = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Relatório — ${campaign.name}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 40px auto; padding: 0 20px; color: #1a1a2e; line-height: 1.8; }
    h1 { font-size: 1.6rem; border-bottom: 3px solid #6366f1; padding-bottom: 12px; }
    h2 { font-size: 1.2rem; color: #6366f1; margin-top: 2rem; }
    .meta { color: #666; font-size: 0.85rem; margin-bottom: 2rem; }
    .content { white-space: pre-wrap; }
    .footer { margin-top: 3rem; font-size: 0.8rem; color: #999; border-top: 1px solid #eee; padding-top: 1rem; }
  </style>
</head>
<body>
  <h1>Relatório ${tipo.charAt(0).toUpperCase() + tipo.slice(1)}</h1>
  <div class="meta">
    <strong>${campaign.name}</strong> | ${campaign.cargo} | ${campaign.city}/${campaign.state}<br>
    Gerado em: ${new Date().toLocaleDateString('pt-BR', { day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit' })}
  </div>
  <div class="content">${text.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
  <div class="footer">Gerado pelo Agente FC — CIC Centro de Inteligência de Campanha</div>
</body>
</html>`

        // Salva HTML no Supabase Storage
        const filename = `relatorio-${tipo}-${relatorio.id}.html`
        const { data: stored, error: storageErr } = await fastify.supabase.storage
          .from('relatorios')
          .upload(filename, Buffer.from(htmlContent, 'utf-8'), {
            contentType: 'text/html; charset=utf-8',
            upsert: true
          })

        let url = null
        if (!storageErr && stored) {
          const { data: pub } = fastify.supabase.storage
            .from('relatorios')
            .getPublicUrl(filename)
          url = pub?.publicUrl || null
        }

        // Se storage falhar, salva o texto direto no banco
        await fastify.supabase.from('relatorios')
          .update({
            status:  'gerado',
            url,
            conteudo: url ? null : text,  // fallback: texto no banco
            tokens:  Math.ceil(text.length / 4),
            gerado_em: new Date()
          })
          .eq('id', relatorio.id)

      } catch (err) {
        fastify.log.error('Erro ao gerar relatório:', err.message)
        await fastify.supabase.from('relatorios')
          .update({ status: 'erro', error: err.message })
          .eq('id', relatorio.id)
      }
    })()

    // Retorna imediatamente com o ID para polling
    return reply.status(202).send({
      relatorioId: relatorio.id,
      status:      'gerando',
      tipo,
      campanha:    campaign.name,
      message:     'Relatório em geração. Use GET /relatorios/:id/status para acompanhar.'
    })
  })

  // GET /campaigns/:id/relatorios/:rid/status — polling do status
  fastify.get('/:id/relatorios/:rid/status', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('relatorios')
      .select('id, tipo, status, url, conteudo, tokens, gerado_em, created_at')
      .eq('id', req.params.rid)
      .eq('campaign_id', req.params.id)
      .single()

    if (error || !data) return reply.status(404).send({ error: 'Relatório não encontrado' })
    return data
  })

  // GET /campaigns/:id/relatorios/historico — lista relatórios
  fastify.get('/:id/relatorios/historico', {
    preHandler: [fastify.authenticate]
  }, async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('relatorios')
      .select('id, tipo, status, url, tokens, gerado_em, created_at')
      .eq('campaign_id', req.params.id)
      .order('created_at', { ascending: false })

    if (error) return reply.status(500).send({ error: error.message })
    return { relatorios: data }
  })
}
