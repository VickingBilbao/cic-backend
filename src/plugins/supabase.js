import fp from 'fastify-plugin'
import { createClient } from '@supabase/supabase-js'

async function supabasePlugin(fastify) {
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY, // service key para bypass de RLS no backend
    {
      auth: { autoRefreshToken: false, persistSession: false }
    }
  )

  // Instância pública (usa anon key — respeita RLS)
  const supabasePublic = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY
  )

  fastify.decorate('supabase', supabase)
  fastify.decorate('supabasePublic', supabasePublic)

  fastify.log.info('✅ Supabase conectado')
}

export default fp(supabasePlugin, {
  name: 'supabase',
  fastify: '4.x'
})
