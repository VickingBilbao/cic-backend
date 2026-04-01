/**
 * BullMQ Queue Definitions
 * CIC — Centro de Inteligência de Campanha
 *
 * Three queues:
 *   cic:text  — Claude text generation (articles, scripts, strategy, analysis)
 *   cic:image — Gemini Nano Banana 2 image generation
 *   cic:video — HeyGen avatar video generation
 */

import { Queue } from 'bullmq'

// ---------------------------------------------------------------------------
// Queue name constants (imported by workers)
// ---------------------------------------------------------------------------
export const TEXT_QUEUE_NAME  = 'cic:text'
export const IMAGE_QUEUE_NAME = 'cic:image'
export const VIDEO_QUEUE_NAME = 'cic:video'

// ---------------------------------------------------------------------------
// Queue instances (lazy — created on first use)
// ---------------------------------------------------------------------------
let _textQueue  = null
let _imageQueue = null
let _videoQueue = null

function getConnection() {
  if (!process.env.REDIS_URL) throw new Error('REDIS_URL not set')
  return { url: process.env.REDIS_URL }
}

function textQueue() {
  if (!_textQueue) _textQueue = new Queue(TEXT_QUEUE_NAME, { connection: getConnection() })
  return _textQueue
}

function imageQueue() {
  if (!_imageQueue) _imageQueue = new Queue(IMAGE_QUEUE_NAME, { connection: getConnection() })
  return _imageQueue
}

function videoQueue() {
  if (!_videoQueue) _videoQueue = new Queue(VIDEO_QUEUE_NAME, { connection: getConnection() })
  return _videoQueue
}

// ---------------------------------------------------------------------------
// Enqueue helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a text generation job.
 * @param {object} payload — { jobId, campaignId, orgId, data }
 */
export async function enqueueTextJob(payload) {
  return textQueue().add('generate', payload, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 100 },
  })
}

/**
 * Enqueue an image generation job (Nano Banana 2).
 * @param {object} payload — { jobId, campaignId, orgId, data }
 */
export async function enqueueImageJob(payload) {
  return imageQueue().add('generate', payload, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { count: 200 },
    removeOnFail:     { count: 100 },
  })
}

/**
 * Enqueue an avatar video job (HeyGen).
 * @param {object} payload — { jobId, campaignId, orgId, data }
 */
export async function enqueueVideoJob(payload) {
  return videoQueue().add('generate', payload, {
    attempts: 2,
    backoff: { type: 'fixed', delay: 60000 },  // wait 1 min before retry
    removeOnComplete: { count: 100 },
    removeOnFail:     { count: 50 },
  })
}

/**
 * Get BullMQ job status by queue name + job ID.
 * Returns { state, progress, result, failedReason }
 */
export async function getJobStatus(queueName, bullJobId) {
  const q = queueName === TEXT_QUEUE_NAME  ? textQueue()
          : queueName === IMAGE_QUEUE_NAME ? imageQueue()
          : videoQueue()

  const job = await q.getJob(bullJobId)
  if (!job) return null

  const state = await job.getState()
  return {
    state,
    progress: job.progress,
    result:   job.returnvalue,
    failedReason: job.failedReason,
  }
}
