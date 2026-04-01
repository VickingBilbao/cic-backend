/**
 * CIC — Worker de Geração de Texto
 * Processa jobs da fila cic:text via BullMQ
 * Executar separadamente: node src/workers/text.worker.js
 */

import 'dotenv/config'
import { Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { generate } from '../services/claude.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const connection = {
  url: process.env.REDIS_URL || 'redis://localhost:6379'
}

const worker = new Worker('cic:text', async (job) => {
  const { campaign_id, agente, tipo, parametros, prompt, job_db_id } = job.data

  console.log(`[Worker] Processando job ${job.id} — agente: ${agente}, tipo: ${tipo}`)

  // Atualiza status do job no banco
  await supabase.from('jobs').update({ status: 'processing' }).eq('id', job_db_id)
  await job.updateProgress(10)

  // Busca campanha para contexto
  const { data: campaign } = await supabase.from('campaigns').select('*').eq('id', campaign_id).single()
  await job.updateProgress(20)

  // Monta prompt final
  const fullPrompt = prompt || buildPromptFromParams(tipo, parametros, campaign)

  // Gera via Claude + RAG
  const { text, usage, model, ragUsed } = await generate({
    supabase, campaign, prompt: fullPrompt, agente, maxTokens: 4096
  })
  await job.updateProgress(80)

  // Salva resultado como content_item
  const { data: content } = await supabase.from('content_items').insert({
    campaign_id,
    agent:  agente,
    type:   tipo,
    prompt: fullPrompt,
    output: text,
    status: 'pending'
  }).select().single()

  // Atualiza job como concluído
  await supabase.from('jobs').update({
    status:    'done',
    result_id: content.id,
    done_at:   new Date()
  }).eq('id', job_db_id)

  await job.updateProgress(100)

  console.log(`[Worker] ✅ Job ${job.id} concluído — content_id: ${content.id} — ${usage?.output_tokens || '?'} tokens — RAG: ${ragUsed}`)

  return { contentId: content.id, tokens: usage?.output_tokens, model, ragUsed }
}, {
  connection,
  concurrency: 3  // até 3 jobs simultâneos
})

worker.on('failed', async (job, err) => {
  console.error(`[Worker] ❌ Job ${job?.id} falhou:`, err.message)
  if (job?.data?.job_db_id) {
    await supabase.from('jobs').update({ status: 'failed', error: err.message }).eq('id', job.data.job_db_id)
  }
})

worker.on('ready', () => console.log('✅ Text Worker pronto — aguardando jobs'))

// Monta prompt a partir de parâmetros estruturados
function buildPromptFromParams(tipo, params, campaign) {
  const candidato = `${campaign?.name} (${campaign?.cargo} - ${campaign?.city}/${campaign?.state})`
  const prompts = {
    roteiro:    `Crie um roteiro de discurso para ${candidato}. Tema: ${params.tema}. Duração: ${params.duracao || '5 minutos'}. Tom: ${params.tom || 'emotivo e direto'}. Evento: ${params.evento || 'comício'}.`,
    jingle:     `Crie a letra de um jingle eleitoral para ${candidato}. Tema: ${params.tema}. Ritmo: ${params.ritmo || 'marchinha'}. Duração: ${params.duracao || '30 segundos'}.`,
    artigo:     `Escreva um artigo de opinião para ${candidato} sobre: ${params.tema}. Veículo: ${params.veiculo || 'imprensa local'}. Extensão: ${params.extensao || '600 palavras'}.`,
    post_social:`Crie ${params.quantidade || 3} posts para redes sociais de ${candidato}. Tema: ${params.tema}. Tom: ${params.tom || 'próximo e humano'}. Plataforma: ${params.plataforma || 'Instagram e Facebook'}.`,
    estrategia: `Elabore uma estratégia de comunicação para ${candidato}. Cenário: ${params.cenario}. Objetivo: ${params.objetivo}. Prazo: ${params.prazo || '30 dias'}.`,
    analise:    `Faça uma análise estratégica para ${candidato} sobre: ${params.tema}. Dados disponíveis: ${JSON.stringify(params.dados || {})}. Recomende ações concretas.`,
    flyer:      `Descreva o conceito visual e crie o texto para um flyer de ${candidato}. Evento: ${params.evento}. Mensagem principal: ${params.mensagem}.`
  }
  return prompts[tipo] || `Crie conteúdo do tipo "${tipo}" para ${candidato}: ${JSON.stringify(params)}`
}
