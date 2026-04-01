/**
 * CIC — Serviço RAG
 * Busca os chunks mais relevantes do Segundo Cérebro via pgvector
 * e monta o contexto para o prompt do agente FC
 */

import { GoogleGenerativeAI } from '@google/generative-ai'

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY)

// ── Gera embedding via Google text-embedding-004 (gratuito, ótimo para português)
export async function getEmbedding(text) {
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' })
    const result = await model.embedContent({
      content: { parts: [{ text: text.slice(0, 8000) }] },
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 1536,
    })
    return result.embedding.values
  } catch (err) {
    console.error('[RAG] Embedding error:', err.message)
    return null  // RAG será pulado graciosamente
  }
}

// ── Busca os N chunks mais relevantes no pgvector
export async function retrieveContext(supabase, query, options = {}) {
  const {
    limit     = 5,
    threshold = 0.72,
    chapters  = null    // filtrar capítulos específicos por agente
  } = options

  const embedding = await getEmbedding(query)
  if (!embedding) return ''  // sem chave de embedding → pula RAG

  const { data, error } = await supabase.rpc('match_knowledge', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count:     limit
  })

  if (error) {
    console.error('RAG retrieval error:', error)
    return ''
  }

  if (!data || data.length === 0) return ''

  // Filtra por capítulos se o agente tiver preferência
  let chunks = data
  if (chapters && chapters.length > 0) {
    const filtered = data.filter(d => chapters.includes(d.chapter))
    chunks = filtered.length >= 2 ? filtered : data // fallback se filtro retornar pouco
  }

  return chunks
    .map(d => `[Capítulo ${d.chapter} — ${d.title || ''}]\n${d.content}`)
    .join('\n\n---\n\n')
}

// ── Monta o prompt completo: System FC+ + RAG context + briefing do candidato
export function buildPrompt({ campaign, ragContext, agente, systemPromptBase, agentSubPrompt = '' }) {
  const agenteSections = {
    roteiros: {
      caps: [3,4,6,9,11,16,24,25,29,36,37],
      instrucao: `Você é especialista em roteiros políticos emocionais e mobilizadores.
Crie roteiros que gerem conexão genuína, não discurso político genérico.
Adapte linguagem ao cargo: prefeito fala de cidade, vereador fala de bairro.`
    },
    estrategia: {
      caps: [2,5,8,14,15,22,30],
      instrucao: `Você é especialista em posicionamento e estratégia eleitoral.
Analise cenários, identifique janelas de oportunidade, sugira ações concretas.
Seja direto: FC não quer análise acadêmica, quer decisão de campo.`
    },
    crise: {
      caps: [19,36,39,40],
      instrucao: `Você é especialista em gestão de crises de imagem política.
Aja rápido: diagnóstico → narrativa → resposta → monitoramento.
Nunca sugira silêncio total — sempre há uma resposta estratégica melhor.`
    },
    artigos: {
      caps: [17,21,22,27,28,35,42],
      instrucao: `Você é especialista em artigos de opinião e análises políticas.
Escreva com ironia elegante, contexto histórico e argumento sólido.
Tom: Fernando Carreiro — não acadêmico, não populista. Inteligente e acessível.`
    },
    sentimento: {
      caps: [39,40],
      instrucao: `Você é especialista em análise de sentimento e percepção pública.
Identifique padrões, tendências e riscos nas menções ao candidato.
Traduza dados em ação: o que o time deve fazer com essa informação?`
    },
    geral: { caps: [], instrucao: '' }
  }

  const agConfig = agenteSections[agente] || agenteSections.geral
  const campaignContext = campaign ? `
CAMPANHA ATIVA:
- Candidato: ${campaign.name}
- Cargo: ${campaign.cargo}
- Cidade/Estado: ${campaign.city} - ${campaign.state}
- Ideologia: ${campaign.ideology || 'não informado'}
- Forças: ${(campaign.strengths || []).join(', ')}
- Vulnerabilidades: ${(campaign.vulnerabilities || []).join(', ')}
- Adversários: ${JSON.stringify(campaign.rivals || {})}` : ''

  const ragSection = ragContext ? `
CONHECIMENTO RELEVANTE DO SEGUNDO CÉREBRO DE FERNANDO CARREIRO:
${ragContext}

FIM DO CONTEXTO — Agora responda ao pedido abaixo com base neste conhecimento.` : ''

  return {
    system: `${systemPromptBase}

${agentSubPrompt || agConfig.instrucao}
${campaignContext}`,
    ragSection
  }
}

// ── Capítulos por agente (para filtrar o RAG)
export const AGENT_CHAPTERS = {
  roteiros:   [3,4,6,9,11,16,24,25,29,36,37],
  estrategia: [2,5,8,14,15,22,30],
  crise:      [19,36,39,40],
  artigos:    [17,21,22,27,28,35,42],
  sentimento: [39,40],
  geral:      []
}
