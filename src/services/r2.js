/**
 * Cloudflare R2 Storage Service
 * CIC — Centro de Inteligência de Campanha
 *
 * Handles upload, download, signed URL generation and deletion
 * for media assets (photos, generated images, avatar videos, audio).
 * R2 is S3-compatible — uses @aws-sdk/client-s3 with custom endpoint.
 */

import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// ---------------------------------------------------------------------------
// Client singleton
// ---------------------------------------------------------------------------

let _client = null

function getClient() {
  if (_client) return _client

  const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env

  if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    throw new Error(
      'R2 credentials missing: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    )
  }

  _client = new S3Client({
    region: 'auto',
    endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  })
  return _client
}

const BUCKET = () => {
  const b = process.env.R2_BUCKET_NAME
  if (!b) throw new Error('R2_BUCKET_NAME env var not set')
  return b
}

// Public CDN base URL (set if bucket has a custom public domain)
const CDN_BASE = () => process.env.R2_PUBLIC_URL ?? null

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * Build a storage key:  {orgId}/{campaignId}/{tipo}/{uuid_filename.ext}
 * tipo: 'fotos' | 'geradas' | 'avatares' | 'audio' | 'documentos'
 */
export function buildKey({ orgId, campaignId, tipo, filename, unique = true }) {
  const ext = path.extname(filename).toLowerCase() || ''
  const base = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_')
  const name = unique ? `${randomUUID()}_${base}${ext}` : `${base}${ext}`
  return `${orgId}/${campaignId}/${tipo}/${name}`
}

export function publicUrl(key) {
  const base = CDN_BASE()
  return base ? `${base.replace(/\/$/, '')}/${key}` : null
}

// ---------------------------------------------------------------------------
// Core operations
// ---------------------------------------------------------------------------

/**
 * Upload a Buffer to R2.
 * Returns { key, url (CDN or null), etag }
 */
export async function uploadBuffer({ key, body, contentType, metadata = {} }) {
  const client = getClient()
  const cmd = new PutObjectCommand({
    Bucket: BUCKET(),
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: Object.fromEntries(
      Object.entries(metadata).map(([k, v]) => [k, String(v)])
    ),
  })
  const result = await client.send(cmd)
  return { key, url: publicUrl(key), etag: result.ETag?.replace(/"/g, '') ?? null }
}

/** Upload a base64-encoded string (e.g. from Gemini image response). */
export async function uploadBase64({ key, base64, contentType, metadata = {} }) {
  const body = Buffer.from(base64, 'base64')
  return uploadBuffer({ key, body, contentType, metadata })
}

/** Download a URL and re-upload to R2 (for expiring HeyGen video URLs). */
export async function uploadFromUrl({ key, sourceUrl, contentType }) {
  const res = await fetch(sourceUrl)
  if (!res.ok) throw new Error(`Fetch failed ${sourceUrl}: ${res.status}`)
  const ct = contentType ?? res.headers.get('content-type') ?? 'application/octet-stream'
  const body = Buffer.from(await res.arrayBuffer())
  return uploadBuffer({ key, body, contentType: ct })
}

/** Pre-signed GET URL for private objects (default 1 hour). */
export async function getPresignedUrl(key, expiresIn = 3600) {
  const client = getClient()
  return getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET(), Key: key }), { expiresIn })
}

/** Pre-signed PUT URL for direct browser uploads (default 5 min). */
export async function getPresignedPutUrl({ key, contentType, expiresIn = 300 }) {
  const client = getClient()
  const cmd = new PutObjectCommand({ Bucket: BUCKET(), Key: key, ContentType: contentType })
  return getSignedUrl(client, cmd, { expiresIn })
}

/** Delete an object. */
export async function deleteObject(key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: BUCKET(), Key: key }))
}

/** Check if an object exists. */
export async function objectExists(key) {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: BUCKET(), Key: key }))
    return true
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return false
    throw err
  }
}

/** List objects under a prefix. */
export async function listObjects(prefix, maxKeys = 100) {
  const result = await getClient().send(
    new ListObjectsV2Command({ Bucket: BUCKET(), Prefix: prefix, MaxKeys: maxKeys })
  )
  return (result.Contents ?? []).map(obj => ({
    key: obj.Key,
    size: obj.Size,
    lastModified: obj.LastModified,
    url: publicUrl(obj.Key),
  }))
}

/**
 * Resolve a stored key to a usable URL.
 * Uses public CDN if configured, otherwise generates a 1-hour pre-signed URL.
 */
export async function resolveUrl(key) {
  const pub = publicUrl(key)
  if (pub) return pub
  return getPresignedUrl(key, 3600)
}

/** Add resolved URLs to an array of media_asset rows (with storage_key field). */
export async function resolveAssetUrls(assets) {
  return Promise.all(assets.map(async a => ({ ...a, url: await resolveUrl(a.storage_key) })))
}
