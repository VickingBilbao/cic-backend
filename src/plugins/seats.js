/**
 * Seat Enforcement Plugin
 * Checks seats_limit before any route that creates a new profile/member.
 *
 * Usage: decorate fastify with fastify.checkSeatsLimit(org_id)
 *   — throws 429 if org has reached its cadeiras limit
 */

import fp from 'fastify-plugin'

async function seatsPlugin(fastify) {
  fastify.decorate('checkSeatsLimit', async function (org_id) {
    if (!org_id) return  // super admin ops bypass

    const [{ data: cfg }, { count }] = await Promise.all([
      fastify.supabase
        .from('org_configs')
        .select('seats_limit')
        .eq('org_id', org_id)
        .single(),
      fastify.supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id),
    ])

    const limit = cfg?.seats_limit ?? 1
    if ((count || 0) >= limit) {
      const err = new Error(
        `Limite de cadeiras atingido (${limit}/${limit}). Adquira mais cadeiras para adicionar membros.`
      )
      err.statusCode = 429
      throw err
    }
  })
}

export default fp(seatsPlugin, { name: 'seats' })
