/**
 * Super Admin Routes — /api/v1/sadmin/*
 * Exclusivo para Victor & Marcos. Fernando nem sabe que existe.
 *
 * Rotas:
 *   GET    /sadmin/stats
 *   GET    /sadmin/orgs
 *   GET    /sadmin/orgs/:id
 *   POST   /sadmin/orgs
 *   PATCH  /sadmin/orgs/:id
 *   GET    /sadmin/orgs/:id/members
 *   POST   /sadmin/orgs/:id/members       — cria membro direto (sem convite)
 *   PATCH  /sadmin/orgs/:id/members/:uid  — altera role
 *   DELETE /sadmin/orgs/:id/members/:uid  — remove membro
 *   PATCH  /sadmin/orgs/:id/seats         — atualiza limite de cadeiras
 *   POST   /sadmin/orgs/:id/impersonate   — gera JWT temporário para suporte
 *   GET    /sadmin/plans
 *   POST   /sadmin/plans
 *   PATCH  /sadmin/plans/:id
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
    const [orgs, plans, profiles] = await Promise.all([
      fastify.supabase.from('org_configs').select('monthly_value,plan_status,created_at,seats_limit'),
      fastify.supabase.from('subscription_plans').select('*').order('sort_order'),
      fastify.supabase.from('profiles').select('org_id,role,created_at').neq('is_super_admin', true),
    ])
    const active = (orgs.data||[]).filter(o=>o.plan_status==='active')
    const mrr    = active.reduce((s,o)=>s+(Number(o.monthly_value)||0),0)

    // members per org
    const membersByOrg = {}
    for (const p of profiles.data||[]) {
      if (!p.org_id) continue
      membersByOrg[p.org_id] = (membersByOrg[p.org_id]||0) + 1
    }

    return {
      total:        (orgs.data||[]).length,
      active:       active.length,
      trial:        (orgs.data||[]).filter(o=>o.plan_status==='trial').length,
      mrr, arr:     mrr * 12,
      total_seats:  (orgs.data||[]).reduce((s,o)=>s+(o.seats_limit||1),0),
      total_members:(profiles.data||[]).length,
      plans:        plans.data||[],
    }
  })

  // ── Orgs list ──────────────────────────────────────────────────────────────
  fastify.get('/orgs', async (req, reply) => {
    const { data: orgs, error } = await fastify.supabase
      .from('org_configs').select('*').order('created_at',{ascending:false})
    if (error) return reply.status(500).send({ error: error.message })

    // Enrich with member count
    const safeOrgs = await Promise.all((orgs||[]).map(async (org) => {
      const { count } = await fastify.supabase
        .from('profiles')
        .select('id',{count:'exact',head:true})
        .eq('org_id', org.org_id)
        .neq('is_super_admin', true)
      const { data: cams } = await fastify.supabase
        .from('campaigns')
        .select('id',{count:'exact',head:false})
        .eq('org_id', org.org_id)
      const { claude_api_key, ...safe } = org
      return { ...safe, has_api_key: !!claude_api_key, member_count: count||0, campaign_count: (cams||[]).length }
    }))

    return safeOrgs
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
      email:         b.owner_email,
      password:      b.owner_password || 'CicTemp@2026!',
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
      owner_name:          b.owner_name          || null,
      persona_name:        b.persona_name        || 'Aria',
      persona_title:       b.persona_title       || 'Inteligência de Campanha',
      persona_description: b.persona_description || 'Sua estrategista política com IA',
      persona_short_desc:  b.persona_short_desc  || 'IA Estratégica',
      modules_enabled:     b.modules_enabled     || ['dash','ia','agenda','crm','demandas','comm','config'],
      max_candidates:      b.max_candidates      || 1,
      seats_limit:         b.seats_limit         || 1,
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
    if (updates.claude_api_key === '') delete updates.claude_api_key
    const { data, error } = await fastify.supabase
      .from('org_configs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select().single()
    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  // ── List members of an org ─────────────────────────────────────────────────
  fastify.get('/orgs/:id/members', async (req, reply) => {
    // :id here is the org_configs.id — fetch org_id first
    const { data: cfg, error: ce } = await fastify.supabase
      .from('org_configs').select('org_id').eq('id', req.params.id).single()
    if (ce) return reply.status(404).send({ error: 'Org não encontrada' })

    const { data, error } = await fastify.supabase
      .from('profiles')
      .select('id, name, email, role, created_at, updated_at')
      .eq('org_id', cfg.org_id)
      .order('created_at', { ascending: true })

    if (error) return reply.status(500).send({ error: error.message })

    // Fetch pending invites too
    const { data: invites } = await fastify.supabase
      .from('org_invites')
      .select('id, email, role, expires_at, created_at')
      .eq('org_id', cfg.org_id)
      .is('accepted_at', null)
      .gt('expires_at', new Date().toISOString())

    return {
      members:        data || [],
      pending_invites: invites || [],
      org_id:         cfg.org_id,
    }
  })

  // ── Add member directly to an org (creates Supabase user) ─────────────────
  fastify.post('/orgs/:id/members', async (req, reply) => {
    const b = req.body || {}
    const { data: cfg, error: ce } = await fastify.supabase
      .from('org_configs').select('org_id, seats_limit').eq('id', req.params.id).single()
    if (ce) return reply.status(404).send({ error: 'Org não encontrada' })

    // Check seat limit
    const { count } = await fastify.supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', cfg.org_id)
    if (count >= (cfg.seats_limit || 1))
      return reply.status(400).send({ error: `Limite de cadeiras atingido (${cfg.seats_limit}). Atualize o plano para adicionar mais membros.` })

    // Create auth user
    const { data: au, error: ae } = await fastify.supabase.auth.admin.createUser({
      email:         b.email,
      password:      b.password || 'CicTemp@2026!',
      email_confirm: true,
    })
    if (ae) return reply.status(400).send({ error: ae.message })

    // Create profile linked to this org
    const { data: profile, error: pe } = await fastify.supabase.from('profiles').upsert({
      id:     au.user.id,
      name:   b.name || b.email,
      email:  b.email,
      org_id: cfg.org_id,
      role:   b.role || 'member',
    }).select().single()

    if (pe) return reply.status(500).send({ error: pe.message })
    return { success: true, member: profile }
  })

  // ── Update member role ─────────────────────────────────────────────────────
  fastify.patch('/orgs/:id/members/:uid', async (req, reply) => {
    const { data: cfg } = await fastify.supabase
      .from('org_configs').select('org_id').eq('id', req.params.id).single()
    if (!cfg) return reply.status(404).send({ error: 'Org não encontrada' })

    const { data, error } = await fastify.supabase
      .from('profiles')
      .update({ role: req.body.role, updated_at: new Date().toISOString() })
      .eq('id', req.params.uid)
      .eq('org_id', cfg.org_id)   // security: ensure member belongs to this org
      .select().single()

    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  // ── Remove member from org ─────────────────────────────────────────────────
  fastify.delete('/orgs/:id/members/:uid', async (req, reply) => {
    const { data: cfg } = await fastify.supabase
      .from('org_configs').select('org_id').eq('id', req.params.id).single()
    if (!cfg) return reply.status(404).send({ error: 'Org não encontrada' })

    // Safety: can't remove org owner (org_id === uid for the first user)
    if (cfg.org_id === req.params.uid)
      return reply.status(400).send({ error: 'Não é possível remover o proprietário da organização' })

    // Delete Supabase auth user (also removes profile via cascade or trigger)
    const { error: authErr } = await fastify.supabase.auth.admin.deleteUser(req.params.uid)
    if (authErr) return reply.status(500).send({ error: authErr.message })

    return { success: true }
  })

  // ── Update seats limit ─────────────────────────────────────────────────────
  fastify.patch('/orgs/:id/seats', async (req, reply) => {
    const { seats_limit } = req.body || {}
    if (!seats_limit || seats_limit < 1)
      return reply.status(400).send({ error: 'seats_limit deve ser >= 1' })

    const { data, error } = await fastify.supabase
      .from('org_configs')
      .update({ seats_limit, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, org_id, seats_limit').single()

    if (error) return reply.status(500).send({ error: error.message })
    return data
  })

  // ── Impersonate — generate JWT for an org's admin user ────────────────────
  // Used for support: Victor/Marcos can log in as the marketeiro to debug issues
  fastify.post('/orgs/:id/impersonate', async (req, reply) => {
    const { data: cfg, error: ce } = await fastify.supabase
      .from('org_configs').select('org_id').eq('id', req.params.id).single()
    if (ce) return reply.status(404).send({ error: 'Org não encontrada' })

    // Find the org's admin user
    const { data: adminProfile, error: pe } = await fastify.supabase
      .from('profiles')
      .select('id, email, name, role')
      .eq('org_id', cfg.org_id)
      .eq('role', 'admin')
      .order('created_at', { ascending: true })
      .limit(1)
      .single()

    if (pe || !adminProfile) return reply.status(404).send({ error: 'Nenhum admin encontrado nesta org' })

    // Generate a one-time login link for the admin user
    const { data: linkData, error: le } = await fastify.supabase.auth.admin.generateLink({
      type: 'magiclink',
      email: adminProfile.email,
      options: { redirectTo: process.env.FRONTEND_URL || 'https://cic-frontend-sigma.vercel.app' }
    })

    if (le) return reply.status(500).send({ error: le.message })

    return {
      success:        true,
      impersonating:  adminProfile,
      magic_link:     linkData.properties?.action_link,
      expires_in:     '1 hora',
      warning:        'Este link concede acesso total à conta. Use apenas para suporte técnico.',
    }
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
