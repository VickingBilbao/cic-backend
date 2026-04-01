/**
 * Image Generation Worker — BullMQ
 * CIC — Centro de Inteligência de Campanha
 *
 * Processes jobs from the 'cic:image' queue.
 * Flow:
 *   1. (Optional) Upload raw photo to R2 (if base64Photo provided)
 *   2. Call Google Gemini gemini-2.0-flash-preview-image-generation ("Nano Banana 2")
 *      with style instructions + campaign context
 *   3. Upload generated image to R2 under {orgId}/{campaignId}/geradas/
 *   4. Save record to media_assets table
 *   5. Update jobs table with status + result
 */

import { Worker } from 'bullmq'
import { GoogleGenerativeAI } from '@google/generative-ai'
import { createClient } from '@supabase/supabase-js'
import { buildKey, uploadBase64, resolveUrl } from '../services/r2.js'
import { IMAGE_QUEUE_NAME } from '../queues/index.js'

// ---------------------------------------------------------------------------
// Supabase client (service key — bypasses RLS for worker operations)
// ---------------------------------------------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ---------------------------------------------------------------------------
// Gemini client
// ---------------------------------------------------------------------------
function getGemini() {
  const key = process.env.GOOGLE_API_KEY
  if (!key) throw new Error('GOOGLE_API_KEY not set')
  return new GoogleGenerativeAI(key)
}

// ---------------------------------------------------------------------------
// Style presets used by Nano Banana 2
// ---------------------------------------------------------------------------
const STYLE_PRESETS = {
  campanha:      'Foto profissional de campanha política, fundo desfocado, iluminação natural, cores vibrantes',
  panfleto:      'Arte gráfica para panfleto político, tipografia bold, cores da campanha, clean design',
  redes:         'Post para redes sociais, quadrado 1:1, identidade visual da campanha, moderno e impactante',
  banner:        'Banner horizontal para outdoor/busdoor, alta resolução, texto legível, impacto visual',
  capa:          'Capa para Facebook/YouTube, 16:9, profissional, com espaço para texto sobreposto',
  midia:         'Foto de assessoria de imprensa, fundo neutro, expressão confiante, terno ou roupa formal',
  evento:        'Registro de evento político, multidão ao fundo, candidato em destaque, bandeiras e cartazes',
  personalizado: '',
}

// ---------------------------------------------------------------------------
// Build Gemini prompt from job data
// ---------------------------------------------------------------------------
function buildImagePrompt(data) {
  const { candidato, partido, municipio, estilo, instrucao, cores } = data
  const baseStyle = STYLE_PRESETS[estilo] ?? STYLE_PRESETS.campanha
  const colorHint = cores ? `Paleta de cores: ${cores}.` : ''
  const candidatoCtx = candidato
    ? `O candidato se chama ${candidato}${partido ? ` (${partido})` : ''}${municipio ? `, candidato em ${municipio}` : ''}.`
    : ''
  return [candidatoCtx, baseStyle, colorHint, instrucao ?? '',
    'Imagem fotorrealista, alta qualidade, sem texto sobreposto, pronto para uso em material de campanha.']
    .filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------
async function updateJob(jobId, patch) {
  await supabase.from('jobs').update(patch).eq('id', jobId)
}

async function saveMediaAsset({ campaignId, tipo, storageKey, nome, metadados }) {
  const { data, error } = await supabase
    .from('media_assets')
    .insert({ campaign_id: campaignId, tipo,
      nome: nome ?? storageKey.split('/').pop(), storage_key: storageKey, metadados: metadados ?? {} })
    .select('id').single()
  if (error) throw new Error(`media_assets insert failed: ${error.message}`)
  return data.id
}

// ---------------------------------------------------------------------------
// Main job processor
// ---------------------------------------------------------------------------
async function processImageJob(job) {
  const { jobId, campaignId, orgId, data } = job.data
  await updateJob(jobId, { status: 'processing', started_at: new Date().toISOString() })

  try {
    // Step 1 — optionally upload raw photo provided by user
    let sourcePhotoKey = null
    if (data.base64Photo) {
      const ext = data.photoMime?.split('/')[1] ?? 'jpg'
      sourcePhotoKey = buildKey({ orgId, campaignId, tipo: 'fotos', filename: `upload.${ext}` })
      await uploadBase64({ key: sourcePhotoKey, base64: data.base64Photo,
        contentType: data.photoMime ?? 'image/jpeg',
        metadata: { campaignId, source: 'user-upload' } })
    }

    // Step 2 — call Nano Banana 2 (Gemini image generation)
    const model = getGemini().getGenerativeModel({
      model: 'gemini-2.0-flash-preview-image-generation',
    })
    const prompt = buildImagePrompt(data)
    const parts = [{ text: prompt }]
    if (data.base64Photo && data.photoMime) {
      parts.unshift({ inlineData: { mimeType: data.photoMime, data: data.base64Photo } })
    }

    const result = await model.generateContent({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] },
    })

    const candidate = result.response.candidates?.[0]
    if (!candidate) throw new Error('Gemini returned no candidates')

    const imagePart = candidate.content.parts.find(
      p => p.inlineData?.mimeType?.startsWith('image/')
    )
    if (!imagePart) throw new Error('Gemini response contained no image part')

    const { mimeType, data: imageBase64 } = imagePart.inlineData
    const ext = mimeType.split('/')[1] ?? 'png'

    // Step 3 — upload generated image to R2
    const geradaKey = buildKey({ orgId, campaignId, tipo: 'geradas', filename: `gerada.${ext}` })
    await uploadBase64({ key: geradaKey, base64: imageBase64, contentType: mimeType,
      metadata: { campaignId, estilo: data.estilo ?? 'campanha', prompt: prompt.slice(0, 200) } })

    // Step 4 — save to media_assets table
    const assetId = await saveMediaAsset({
      campaignId, tipo: 'imagem_gerada', storageKey: geradaKey,
      nome: `${data.estilo ?? 'campanha'}_${Date.now()}.${ext}`,
      metadados: { prompt, estilo: data.estilo, sourcePhotoKey, mimeType,
        model: 'gemini-2.0-flash-preview-image-generation' },
    })

    const url = await resolveUrl(geradaKey)
    const resultPayload = { assetId, storageKey: geradaKey, url, mimeType, prompt, sourcePhotoKey }

    await updateJob(jobId, { status: 'completed', result: resultPayload,
      finished_at: new Date().toISOString() })
    return resultPayload

  } catch (err) {
    await updateJob(jobId, { status: 'failed', error: err.message,
      finished_at: new Date().toISOString() })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------
export function startImageWorker(connection) {
  const worker = new Worker(IMAGE_QUEUE_NAME, processImageJob, {
    connection,
    concurrency: 2,
    removeOnComplete: { count: 200 },
    removeOnFail:    { count: 100 },
  })
  worker.on('completed', job => console.log(`[image-worker] ✅ Job ${job.id} completed`))
  worker.on('failed',    (job, err) => console.error(`[image-worker] ❌ Job ${job?.id} failed:`, err.message))
  worker.on('error',     err => console.error('[image-worker] Worker error:', err))
  console.log('[image-worker] Started — listening on cic:image queue')
  return worker
}
