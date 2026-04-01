/**
 * CIC — Script de Seed do RAG
 * Chunkeia o Segundo Cérebro de Fernando Carreiro → gera embeddings → salva no pgvector
 *
 * USO:
 *   1. Coloque o conteúdo dos capítulos em scripts/conhecimento/
 *   2. npm run seed-rag
 *
 * Requer: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY no .env
 */

import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import Anthropic from '@anthropic-ai/sdk'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

// ── Gera embedding via Anthropic (usando OpenAI embeddings como alternativa mais barata)
async function getEmbedding(text) {
  // Anthropic não tem API de embeddings — usamos OpenAI text-embedding-3-small
  // Instale: npm install openai
  const { default: OpenAI } = await import('openai')
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text.slice(0, 8000) // limite de tokens
  })
  return response.data[0].embedding
}

// ── Chunkeia texto em blocos de ~500 palavras com overlap
function chunkText(text, chunkSize = 500, overlap = 50) {
  const words = text.split(/\s+/)
  const chunks = []
  let i = 0
  while (i < words.length) {
    chunks.push(words.slice(i, i + chunkSize).join(' '))
    i += chunkSize - overlap
  }
  return chunks
}

// ── Processa um arquivo de capítulo
async function processCapitulo(filePath, chapterNum) {
  const raw = fs.readFileSync(filePath, 'utf-8')
  const lines = raw.split('\n')
  const title = lines[0].replace(/^#+\s*/, '').trim() || `Capítulo ${chapterNum}`
  const content = lines.slice(1).join('\n').trim()

  const chunks = chunkText(content)
  console.log(`  Capítulo ${chapterNum}: "${title}" — ${chunks.length} chunks`)

  for (let j = 0; j < chunks.length; j++) {
    const chunk = chunks[j]
    if (chunk.length < 100) continue // ignora chunks muito pequenos

    const embedding = await getEmbedding(chunk)

    const { error } = await supabase.from('knowledge_chunks').insert({
      source:    'segundo_cerebro',
      chapter:   chapterNum,
      title:     `${title} (parte ${j + 1})`,
      content:   chunk,
      embedding,
      tags:      ['fcarreiro', 'metodologia', `cap${chapterNum}`]
    })

    if (error) console.error(`    ❌ Erro no chunk ${j}:`, error.message)
    else console.log(`    ✅ Chunk ${j + 1}/${chunks.length} inserido`)

    // Rate limit: 1 request por segundo
    await new Promise(r => setTimeout(r, 1000))
  }
}

// ── Main
async function main() {
  const conhecimentoDir = path.join(__dirname, 'conhecimento')

  if (!fs.existsSync(conhecimentoDir)) {
    console.log('📁 Criando pasta scripts/conhecimento/')
    fs.mkdirSync(conhecimentoDir, { recursive: true })
    console.log('ℹ️  Coloque os arquivos .md dos capítulos em scripts/conhecimento/')
    console.log('   Nomeie como: cap01.md, cap02.md, ... cap43.md')
    return
  }

  const files = fs.readdirSync(conhecimentoDir)
    .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
    .sort()

  if (files.length === 0) {
    console.log('⚠️  Nenhum arquivo encontrado em scripts/conhecimento/')
    return
  }

  console.log(`🚀 Iniciando seed RAG — ${files.length} arquivos encontrados\n`)

  // Limpa chunks existentes do segundo_cerebro antes de re-sedar
  const { error: delError } = await supabase
    .from('knowledge_chunks')
    .delete()
    .eq('source', 'segundo_cerebro')
  if (delError) console.warn('⚠️  Aviso ao limpar chunks:', delError.message)

  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(conhecimentoDir, files[i])
    await processCapitulo(filePath, i + 1)
  }

  const { count } = await supabase
    .from('knowledge_chunks')
    .select('id', { count: 'exact' })
    .eq('source', 'segundo_cerebro')

  console.log(`\n✅ Seed concluído! Total de chunks no banco: ${count}`)
}

main().catch(console.error)
