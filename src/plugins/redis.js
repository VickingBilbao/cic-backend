import fp from 'fastify-plugin'
import Redis from 'ioredis'

async function redisPlugin(fastify) {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
    maxRetriesPerRequest: null, // necessário para BullMQ
    enableReadyCheck: false
  })

  redis.on('connect', () => fastify.log.info('✅ Redis conectado'))
  redis.on('error', (err) => fastify.log.error('Redis error:', err))

  fastify.decorate('redis', redis)

  fastify.addHook('onClose', async () => {
    await redis.quit()
  })
}

export default fp(redisPlugin, {
  name: 'redis',
  fastify: '4.x'
})
