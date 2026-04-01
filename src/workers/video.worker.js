/**
 * Avatar Video Worker — BullMQ
 * CIC — Centro de Inteligência de Campanha
 *
 * Processes jobs from the 'cic:video' queue.
 * Flow:
 *   1. Submit video generation to HeyGen API (avatar + script)
 *   2. Poll HeyGen until video is ready (or timeout after 15 min)
 *   3. Download completed video from HeyGen CDN
 *   4. Upload video to R2 under {orgId}/{campaignId}/avatares/
 *   5. Save record to media_assets table
 *   6. Update jobs table with status + result URL
 *
 * HeyGen API v2 docs: https://docs.heygen.com/reference/generate-video-v2
 */

import { Worker } from 'bullmq'
import { createClient } from '@supabase/supabase-js'
import { buildKey, uploadFromUrl, resolveUrl } from '../services/r2.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

// ---------------------------------------------------------------------------
// HeyGen API helpers
// ---------------------------------------------------------------------------
const HEYGEN_BASE = 'https://api.heygen.com'

function heygenHeaders() {
  const key = process.env.HEYGEN_API_KEY
  if (!key) throw new Error('HEYGEN_API_KEY not set')
  return { 'X-Api-Key': key, 'Content-Type': 'application/json' }
}

/**
 * Submit a video generation request to HeyGen v2.
 * Returns the video_id for polling.
 *
 * @param {object} p
 * @param {string} p.avatarId     — HeyGen avatar ID (from campaign config)
 * @param {string} p.voiceId      — HeyGen voice ID
 * @param {string} p.script       — The spoken script text
 * @param {string} [p.title]      — Video title shown in HeyGen dashboard
 * @param {string} [p.background] — Hex color or 'transparent'
 * @param {string} [p.ratio]      — '16:9' | '9:16' | '1:1'
 */
async function submitHeyGenVideo({ avatarId, voiceId, script, title, background, ratio }) {
  const body = {
    video_inputs: [
      {
        character: {
          type: 'avatar',
          avatar_id: avatarId,
          avatar_style: 'normal',
        },
        voice: {
          type: 'text',
          input_text: script,
          voice_id: voiceId,
        },
        background: background
          ? { type: 'color', value: background }
          : { type: 'color', value: '#ffffff' },
      },
    ],
    dimension: ratio === '9:16'
      ? { width: 720, height: 1280 }
      : ratio === '1:1'
      ? { width: 720, height: 720 }
      : { width: 1280, height: 720 },
    title: title ?? 'CIC Avatar Video',
    test: false,
  }

  const res = await fetch(`${HEYGEN_BASE}/v2/video/generate`, {
    method: 'POST',
    headers: heygenHeaders(),
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok || json.error) {
    throw new Error(`HeyGen submit failed: ${json.error?.message ?? res.status}`)
  }
  return json.data.video_id
}

/**
 * Poll HeyGen until video status is 'completed' or 'failed'.
 * Polls every 15 seconds for up to maxWaitMs.
 */
async function pollHeyGenVideo(videoId, maxWaitMs = 900_000) {
  const interval = 15_000
  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, interval))

    const res = await fetch(`${HEYGEN_BASE}/v1/video_status.get?video_id=${videoId}`, {
      headers: heygenHeaders(),
    })
    const json = await res.json()
    const info = json.data

    if (!info) throw new Error(`HeyGen status check failed: ${JSON.stringify(json)}`)

    if (info.status === 'completed') {
      return { videoUrl: info.video_url, thumbnailUrl: info.thumbnail_url, duration: info.duration }
    }
    if (info.status === 'failed') {
      throw new Error(`HeyGen video failed: ${info.error ?? 'unknown error'}`)
    }
    // status is 'pending' or 'processing' — keep polling
    console.log(`[video-worker] HeyGen ${videoId} status: ${info.status} — waiting...`)
  }

  throw new Error(`HeyGen video ${videoId} timed out after ${maxWaitMs / 60000} minutes`)
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
    .insert({ campaign_id: campaignId, tipo, nome, storage_key: storageKey, metadados })
    .select('id')
    .single()
  if (error) throw new Error(`media_assets insert failed: ${error.message}`)
  return data.id
}

// ---------------------------------------------------------------------------
// Main job processor
// ---------------------------------------------------------------------------
async function processVideoJob(job) {
  const { jobId, campaignId, orgId, data } = job.data
  const {
    avatarId,
    voiceId,
    script,
    titulo,
    background,
    ratio,
    roteiro_id,   // optional — link back to content_item
  } = data

  await updateJob(jobId, { status: 'processing', started_at: new Date().toISOString() })

  try {
    // Step 1 — submit to HeyGen
    console.log(`[video-worker] Submitting to HeyGen for job ${jobId}`)
    const heygenVideoId = await submitHeyGenVideo({
      avatarId, voiceId, script, title: titulo, background, ratio,
    })
    console.log(`[video-worker] HeyGen video_id: ${heygenVideoId}`)

    // Store HeyGen video_id in job so we can check it manually if needed
    await updateJob(jobId, { result: { heygenVideoId, status: 'processing' } })

    // Step 2 — poll until done (up to 15 minutes)
    const { videoUrl, thumbnailUrl, duration } = await pollHeyGenVideo(heygenVideoId)
    console.log(`[video-worker] HeyGen completed: ${videoUrl}`)

    // Step 3 — download from HeyGen CDN and upload to R2
    const videoKey = buildKey({ orgId, campaignId, tipo: 'avatares', filename: `avatar.mp4` })
    await uploadFromUrl({ key: videoKey, sourceUrl: videoUrl, contentType: 'video/mp4' })

    // Step 4 — save thumbnail to R2 if available
    let thumbKey = null
    if (thumbnailUrl) {
      thumbKey = buildKey({ orgId, campaignId, tipo: 'avatares', filename: `thumb.jpg` })
      await uploadFromUrl({ key: thumbKey, sourceUrl: thumbnailUrl, contentType: 'image/jpeg' })
    }

    // Step 5 — save to media_assets
    const assetId = await saveMediaAsset({
      campaignId,
      tipo: 'video_avatar',
      storageKey: videoKey,
      nome: `${titulo ?? 'avatar'}_${Date.now()}.mp4`,
      metadados: {
        heygenVideoId, avatarId, voiceId, duration,
        scriptExcerpt: script.slice(0, 200),
        thumbKey, roteiro_id: roteiro_id ?? null,
      },
    })

    // Link back to roteiro content_item if provided
    if (roteiro_id) {
      await supabase
        .from('content_items')
        .update({ metadados: supabase.rpc('jsonb_set', {}) }) // simple update
        .eq('id', roteiro_id)
      // Simpler: just store the video asset_id in the content_item metadados
      await supabase.from('content_items')
        .update({ status: 'aprovado', metadados: { video_asset_id: assetId } })
        .eq('id', roteiro_id)
    }

    // Step 6 — resolve final URL and mark job complete
    const url = await resolveUrl(videoKey)
    const resultPayload = {
      assetId,
      storageKey: videoKey,
      url,
      thumbKey,
      duration,
      heygenVideoId,
    }

    await updateJob(jobId, {
      status: 'completed',
      result: resultPayload,
      finished_at: new Date().toISOString(),
    })

    return resultPayload

  } catch (err) {
    await updateJob(jobId, {
      status: 'failed',
      error: err.message,
      finished_at: new Date().toISOString(),
    })
    throw err
  }
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------
export function startVideoWorker(connection) {
  const worker = new Worker(
    'cic:video',
    processVideoJob,
    {
      connection,
      concurrency: 1,             // video gen is very slow — one at a time
      lockDuration: 960_000,      // 16 min lock (longer than 15 min poll timeout)
      removeOnComplete: { count: 100 },
      removeOnFail:    { count: 50 },
    }
  )

  worker.on('completed', job => {
    console.log(`[video-worker] ✅ Job ${job.id} completed`)
  })
  worker.on('failed', (job, err) => {
    console.error(`[video-worker] ❌ Job ${job?.id} failed:`, err.message)
  })
  worker.on('error', err => {
    console.error('[video-worker] Worker error:', err)
  })

  console.log('[video-worker] Started — listening on cic:video queue')
  return worker
}
