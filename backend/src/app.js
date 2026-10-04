import Fastify from 'fastify'

export const createApp = () => {
  const app = Fastify({ exposeHeadRoutes: false })
  app.get('/', async () => 'Nia')
  return app
}
