/**
 * CIC — Bot Telegram do Candidato
 * O candidato NÃO acessa o dashboard — usa este bot para fazer pedidos.
 * Claude Haiku classifica → job enfileirado → FC revisa → bot entrega.
 *
 * Executar: node bot/telegram.js
 */

import 'dotenv/config'
import TelegramBot from 'node-telegram-bot-api'
import { createClient } from '@supabase/supabase-js'
import { classifyRequest } from '../src/services/claude.js'
import { enqueueTextJob } from '../src/queues/index.js'

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true })
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)

// Estado de conversas em andamento (usar Redis na produção)
const sessions = new Map()

// ── Mapeia chat_id do Telegram ao candidato/campanha no banco
async function getCampaignByChatId(chatId) {
  const { data } = await supabase
    .from('telegram_candidatos')
    .select('campaign_id, nome_candidato, campaigns(*)')
    .eq('chat_id', String(chatId))
    .single()
  return data
}

// ── Notifica FC no dashboard (salva no banco como notificação)
async function notifyFC(campaignId, message, contentId = null) {
  await supabase.from('notificacoes').insert({
    campaign_id: campaignId,
    tipo:        'novo_pedido',
    mensagem:    message,
    content_id:  contentId,
    lida:        false
  })
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id
  const candidato = await getCampaignByChatId(chatId)

  if (!candidato) {
    return bot.sendMessage(chatId,
      `Olá! Você ainda não está cadastrado no sistema CIC.\nEntre em contato com a equipe de Fernando Carreiro para configurar seu acesso.`
    )
  }

  bot.sendMessage(chatId,
    `✅ *Olá, ${candidato.nome_candidato}!*\n\nSou o assistente do CIC. Pode me pedir:\n\n` +
    `• Roteiro de discurso\n• Post para redes sociais\n• Análise de situação\n• Estratégia para debate\n• Flyer ou comunicado\n\n` +
    `É só descrever o que precisa em linguagem natural.`,
    { parse_mode: 'Markdown' }
  )
})

bot.on('message', async (msg) => {
  if (msg.text?.startsWith('/')) return // ignora outros comandos

  const chatId  = msg.chat.id
  const texto   = msg.text || ''
  const session = sessions.get(chatId) || {}

  const candidato = await getCampaignByChatId(chatId)
  if (!candidato) {
    return bot.sendMessage(chatId, 'Você não está cadastrado no CIC. Fale com a equipe.')
  }

  // Se há uma sessão aguardando mais detalhes
  if (session.awaitingDetail) {
    const payload = { ...session.pendingPayload, detalhe_extra: texto }
    await bot.sendMessage(chatId, '⏳ Perfeito! Registrei seu pedido. A equipe do CIC vai preparar e entregar em breve.')
    await submitJob(candidato, payload, chatId)
    sessions.delete(chatId)
    return
  }

  // Envia indicador de digitação
  bot.sendChatAction(chatId, 'typing')

  try {
    // Classifica o pedido com Claude Haiku
    const classification = await classifyRequest(texto)

    if (classification.needsMoreInfo) {
      // Armazena estado e faz pergunta de esclarecimento
      sessions.set(chatId, {
        awaitingDetail:  true,
        pendingPayload:  { ...classification, texto_original: texto, campaign_id: candidato.campaign_id }
      })
      return bot.sendMessage(chatId, `🤔 ${classification.question}`)
    }

    // Pedido completo — confirma e enfileira
    const tipoLabel = {
      roteiro:      'Roteiro de discurso',
      comunicacao:  'Comunicado / post',
      estrategia:   'Análise estratégica',
      imagem:       'Material visual',
      video:        'Roteiro para vídeo',
      pesquisa:     'Análise de pesquisa',
      agenda:       'Compromisso na agenda',
      outro:        'Pedido especial'
    }

    await bot.sendMessage(chatId,
      `✅ *${tipoLabel[classification.tipo] || 'Pedido'}* registrado!\n\n` +
      `_"${texto}"_\n\nA equipe do CIC vai trabalhar nisso. Você receberá uma notificação aqui quando estiver pronto.`,
      { parse_mode: 'Markdown' }
    )

    await submitJob(candidato, { ...classification, texto_original: texto, campaign_id: candidato.campaign_id }, chatId)

  } catch (err) {
    console.error('Bot error:', err)
    bot.sendMessage(chatId, '❌ Ops, tive um problema técnico. Tente novamente em instantes.')
  }
})

async function submitJob(candidato, payload, chatId) {
  const agenteMap = {
    roteiro:     'roteiros',
    comunicacao: 'artigos',
    estrategia:  'estrategia',
    imagem:      'visual',
    video:       'avatar',
    outro:       'geral'
  }
  const agente = agenteMap[payload.tipo] || 'geral'

  // Cria job no banco
  const { data: job } = await supabase.from('jobs').insert({
    campaign_id: candidato.campaign_id,
    type:        `bot_${payload.tipo}`,
    status:      'queued',
    payload:     { ...payload, source: 'telegram', chat_id: chatId }
  }).select().single()

  // Enfileira no BullMQ
  await enqueueTextJob({
    campaign_id: candidato.campaign_id,
    agente,
    tipo:        payload.tipo,
    parametros:  payload,
    prompt:      payload.texto_original,
    job_db_id:   job.id,
    chat_id:     chatId  // para entregar de volta ao candidato quando pronto
  })

  // Notifica FC
  await notifyFC(candidato.campaign_id,
    `📱 Novo pedido via Telegram de ${candidato.nome_candidato}: ${payload.texto_original?.slice(0, 100)}`
  )
}

// ── Função para entregar resultado ao candidato (chamada pelo worker)
export async function deliverResult(chatId, content) {
  if (!chatId) return
  await bot.sendMessage(chatId,
    `✅ *Seu pedido ficou pronto!*\n\n${content.slice(0, 3000)}${content.length > 3000 ? '\n\n_(texto completo disponível no sistema)_' : ''}`,
    { parse_mode: 'Markdown' }
  )
}

console.log('🤖 CIC Bot Telegram iniciado — aguardando mensagens')
