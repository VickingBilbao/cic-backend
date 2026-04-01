/**
 * Estúdio de Imagem — Routes
 * CIC — Centro de Inteligência de Campanha
 *
 * Endpoints:
 *   POST   /campaigns/:id/imagem/gerar       — Enqueue async Nano Banana 2 job
 *   POST   /campaigns/:id/imagem/upload      — Upload raw photo to R2 (multipart)
 *   POST   /campaigns/:id/imagem/presigned   — Get presigned PUT URL for direct upload
 *   GET    /campaigns/:id/imagem/galeria      — List all media assets for campaign
 *   GET    /campaigns/:id/imagem/job/:jobId  — Poll job status
 *   DELETE /campaigns/:id/imagem/:assetId    — Delete image asset
 */

import fp from 'fastify-plugin'
import { enqueueImageJob } from '../queues/index.js'
import {
  buildKey, uploadBuffer, uploadBase64,
  getPresignedPutUrl, resolveUrl, resolveAssetUrls, deleteObject,
} from '../services/r2.js'

async function imageRoutes(fastify, opts) {
  const { supabase } = fastify

  // -------------------------------------------------------------------------
  // Helper: get campaign + verify access
  // -------------------------------------------------------------------------
  async function getCampaign(campaignId, userId) {
    const { data } = await supabase
      .from('campaigns')
      .select('id, org_id, candidato, partido, municipio, cores_campanha')
      .eq('id', campaignId).single()
    if (!data) return null
    const { data: profile } = await supabase
      .from('profiles').select('org_id').eq('id', userId).single()
    if (!profile || profile.org_id !== data.org_id) return null
    return data
  }

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/imagem/gerar — enqueue async image generation
  // -------------------------------------------------------------------------
  fastify.post('/:id/imagem/gerar', {
    onRequest: [fastify.authenticate],
    schema: {
      params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      body: {
        type: 'object', required: ['estilo'],
        properties: {
          estilo:      { type: 'string', enum: ['campanha','panfleto','redes','banner','capa','midia','evento','personalizado'] },
          instrucao:   { type: 'string', maxLength: 500 },
          base64Photo: { type: 'string' },
          photoMime:   { type: 'string' },
          cores:       { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: jobRow, error: jobErr } = await supabase
      .from('jobs')
      .insert({ campaign_id: campaign.id, tipo: 'image', status: 'queued', payload: request.body })
      .select('id').single()
    if (jobErr) return reply.status(500).send({ error: 'Erro ao criar job' })

    await enqueueImageJob({
      jobId: jobRow.id, campaignId: campaign.id, orgId: campaign.org_id,
      data: {
        ...request.body,
        candidato: campaign.candidato, partido: campaign.partido,
        municipio: campaign.municipio,
        cores: request.body.cores ?? campaign.cores_campanha,
      },
    })
    return reply.status(202).send({ jobId: jobRow.id, status: 'queued' })
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/imagem/upload — multipart file upload to R2
  // -------------------------------------------------------------------------
  fastify.post('/:id/imagem/upload', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const data = await request.file()
    if (!data) return reply.status(400).send({ error: 'Nenhum arquivo enviado' })

    const chunks = []
    for await (const chunk of data.file) chunks.push(chunk)
    const body = Buffer.concat(chunks)

    if (body.length > 20 * 1024 * 1024) {
      return reply.status(413).send({ error: 'Arquivo muito grande (máx 20 MB)' })
    }

    const key = buildKey({
      orgId: campaign.org_id, campaignId: campaign.id,
      tipo: 'fotos', filename: data.filename ?? `upload_${Date.now()}.jpg`,
    })

    const { etag } = await uploadBuffer({
      key, body, contentType: data.mimetype,
      metadata: { campaignId: campaign.id, uploadedBy: request.user.id },
    })

    const { data: asset, error } = await supabase
      .from('media_assets')
      .insert({
        campaign_id: campaign.id, tipo: 'foto_original',
        nome: data.filename ?? key.split('/').pop(), storage_key: key,
        metadados: { mimetype: data.mimetype, size: body.length, etag },
      })
      .select('id').single()

    if (error) return reply.status(500).send({ error: 'Erro ao salvar asset' })

    const url = await resolveUrl(key)
    return reply.status(201).send({ assetId: asset.id, key, url })
  })

  // -------------------------------------------------------------------------
  // POST /campaigns/:id/imagem/presigned — get presigned PUT URL for browser upload
  // -------------------------------------------------------------------------
  fastify.post('/:id/imagem/presigned', {
    onRequest: [fastify.authenticate],
    schema: {
      body: {
        type: 'object', required: ['filename', 'contentType'],
        properties: { filename: { type: 'string' }, contentType: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const key = buildKey({
      orgId: campaign.org_id, campaignId: campaign.id,
      tipo: 'fotos', filename: request.body.filename,
    })
    const putUrl = await getPresignedPutUrl({ key, contentType: request.body.contentType, expiresIn: 300 })
    return { key, putUrl, expiresIn: 300 }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/imagem/galeria — list all media assets
  // -------------------------------------------------------------------------
  fastify.get('/:id/imagem/galeria', {
    onRequest: [fastify.authenticate],
    schema: {
      querystring: {
        type: 'object',
        properties: {
          tipo:   { type: 'string' },
          limit:  { type: 'integer', default: 50 },
          offset: { type: 'integer', default: 0 },
        },
      },
    },
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    let query = supabase
      .from('media_assets')
      .select('*')
      .eq('campaign_id', campaign.id)
      .order('created_at', { ascending: false })
      .range(request.query.offset, request.query.offset + request.query.limit - 1)

    if (request.query.tipo) query = query.eq('tipo', request.query.tipo)

    const { data: assets, error } = await query
    if (error) return reply.status(500).send({ error: error.message })

    return { assets: await resolveAssetUrls(assets), total: assets.length }
  })

  // -------------------------------------------------------------------------
  // GET /campaigns/:id/imagem/job/:jobId — poll job status
  // -------------------------------------------------------------------------
  fastify.get('/:id/imagem/job/:jobId', {
    onRequest: [fastify.authenticate],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: job, error } = await supabase
      .from('jobs')
      .select('id, status, result, error, created_at, finished_at')
      .eq('id', request.params.jobId)
      .eq('campaign_id', campaign.id)
      .single()

    if (error || !job) return reply.status(404).send({ error: 'Job não encontrado' })

    if (job.status === 'completed' && job.result?.storageKey) {
      job.result.url = await resolveUrl(job.result.storageKey)
    }
    return job
  })

  // -------------------------------------------------------------------------
  // DELETE /campaigns/:id/imagem/:assetId — delete image + R2 object
  // -------------------------------------------------------------------------
  fastify.delete('/:id/imagem/:assetId', {
    onRequest: [fastify.authenticate, fastify.requireRole('editor')],
  }, async (request, reply) => {
    const campaign = await getCampaign(request.params.id, request.user.id)
    if (!campaign) return reply.status(404).send({ error: 'Campanha não encontrada' })

    const { data: asset, error } = await supabase
      .from('media_assets')
      .select('id, storage_key')
      .eq('id', request.params.assetId)
      .eq('campaign_id', campaign.id)
      .single()

    if (error || !asset) return reply.status(404).send({ error: 'Asset não encontrado' })

    await deleteObject(asset.storage_key)
    await supabase.from('media_assets').delete().eq('id', asset.id)
    return reply.status(204).send()
  })
}

export default fp(imageRoutes)
