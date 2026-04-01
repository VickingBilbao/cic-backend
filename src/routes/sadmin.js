/**
 * Super Admin Routes — /api/v1/sadmin/*
 * Exclusivo para Victor & Marcos. Fernando nem sabe que existe.
 */

async function sadminRoutes(fastify, opts) {

  // ── Super-admin guard ──────────────────────────────────────────────────────
  fastify.addHook('preHandler', async (req, reply) => {
    try { await req.jwtVerify() } catch {
      return reply.status(401).send({ error: 'Não autenticado' })
    }
    const { data: p } = await fastify.supabase
      .from('profiles').select('is_super_admin').eq('id', req.user.sub).single()
    if (!p?.is_super_admin)
      return reply.status(403).send({ error: 'Acesso negado' })
  })

  // ── Stats ──────────────────────────────────────────────────────────────────
  fastify.get('/stats', async () => {
    const [orgs, plans] = await Promise.all([
      fastify.supabase.from('org_configs').select('monthly_value,plan_status,created_at'),
      fastify.supabase.from('subscription_plans').select('*').order('sort_order'),
    ])
    const active = (orgs.data||[]).filter(o=>o.plan_status==='active')
    const mrr    = active.reduce((s,o)=>s+(Number(o.monthly_value)||0),0)
    return {
      total:  (orgs.data||[]).length,
      active: active.length,
      trial:  (orgs.data||[]).filter(o=>o.plan_status==='trial').length,
      mrr, arr: mrr*12,
      plans: plans.data||[],
    }
  })

  // ── Orgs list ──────────────────────────────────────────────────────────────
  fastify.get('/orgs', async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('org_configs').select('*').order('created_at',{ascending:false})
    if (error) return reply.status(500).send({ error: error.message })
    return (data||[]).map(({claude_api_key,...r})=>({...r,has_api_key:!!claude_api_key}))
  })

  // ── Org detail ─────────────────────────────────────────────────────────────
  fastify.get('/orgs/:id', async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('org_configs').select('*').eq('id', req.params.id).single()
    if (error) return reply.status(404).send({ error: 'Não encontrado' })
    const { claude_api_key, ...safe } = data
    return { ...safe, has_api_key: !!claude_api_key }
  })

  // ── Create org (provisions user + profile + org_config) ───────────────────
  fastify.post('/orgs', async (req, reply) => {
    const b = req.body || {}

    // 1. Create Supabase Auth user
    const { data: au, error: ae } = await fastify.supabase.auth.admin.createUser({
      email: b.owner_email,
      password: b.owner_password || 'CicTemp@2026!',
      email_confirm: true,
    })
    if (ae) return reply.status(400).send({ error: ae.message })

    const uid = au.user.id

    // 2. Create profile
    await fastify.supabase.from('profiles').upsert({
      id:     uid,
      name:   b.owner_name || b.product_name,
      email:  b.owner_email,
      org_id: uid,
      role:   'admin',
    })

    // 3. Create org_config
    const { data: org, error: oe } = await fastify.supabase.from('org_configs').insert({
      org_id:              uid,
      product_name:        b.product_name        || 'CIC',
      persona_name:        b.persona_name        || 'Aria',
      persona_title:       b.persona_title       || 'Inteligência de Campanha',
      persona_description: b.persona_description || 'Sua estrategista política com IA',
      persona_short_desc:  b.persona_short_desc  || 'IA Estratégica',
      modules_enabled:     b.modules_enabled     || ['dash','ia','agenda','crm','demandas','comm','config'],
      max_candidates:      b.max_candidates      || 1,
      claude_api_key:      b.claude_api_key      || null,
      claude_model:        b.claude_model        || 'claude-sonnet-4-6',
      plan_status:         b.plan_status         || 'trial',
      monthly_value:       b.monthly_value       || null,
      setup_paid:          b.setup_paid          || false,
      notes:               b.notes               || null,
      colors:              b.colors              || {},
      font_family:         b.font_family         || 'Inter',
    }).select().single()

    if (oe) return reply.status(500).send({ error: oe.message })
    return { success: true, org_id: uid, org }
  })

  // ── Update org ─────────────────────────────────────────────────────────────
  fastify.patch('/orgs/:id', async (req, reply) => {
    const { org_id, id, created_at, ...updates } = req.body || {}
    // If claude_api_key is empty string, don't overwrite existing key
    if (updates.claude_api_key === '') delete updates.claude_api_key
    const { data, error } = await fastify.supabase
      .from('org_configs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single()
    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  // ── Plans ──────────────────────────────────────────────────────────────────
  fastify.get('/plans', async () => {
    const { data } = await fastify.supabase
      .from('subscription_plans').select('*').order('sort_order')
    return data || []
  })

  fastify.post('/plans', async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('subscription_plans').insert(req.body).select().single()
    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  fastify.patch('/plans/:id', async (req, reply) => {
    const { data, error } = await fastify.supabase
      .from('subscription_plans')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', req.params.id).select().single()
    if (error) return reply.status(500).send({ error: error.message })
    return data
  })
}

export default sadminRoutes
