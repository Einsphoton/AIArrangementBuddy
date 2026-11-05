/** 音色库路由：/api/soundfonts。 */
import type { FastifyInstance } from 'fastify'
import { bundledSoundfonts, downloadSoundfont, findSource, listSoundfontFiles } from '../soundfonts.js'

export function registerSoundfontRoutes(app: FastifyInstance): void {
  app.get('/api/soundfonts', async () => {
    const files = listSoundfontFiles()
    return { files, bundled: files.length > 0 }
  })

  app.post<{ Params: { id: string } }>('/api/soundfonts/:id/download', async (request, reply) => {
    const id = request.params.id
    const source = findSource(id)
    if (!source) {
      return reply.code(404).send({
        error: `未知音色库 id：${id}`,
        available: ['musescore-general', 'musescore-general-sf2', 'generaluser-gs'],
      })
    }
    const result = await downloadSoundfont(source)
    return reply.code(result.ok ? 200 : 502).send(result)
  })

  // 方便前端展示可下载列表（新路径，不影响契约）
  app.get('/api/soundfonts/sources', async () => ({
    sources: [
      {
        id: 'musescore-general',
        name: 'MuseScore_General.sf3',
        label: 'MuseScore General（MIT，全能 GM，推荐）',
        license: 'MIT',
        size: 39_900_972,
        installed: bundledSoundfonts(),
      },
      {
        id: 'musescore-general-sf2',
        name: 'MuseScore_General.sf2',
        label: 'MuseScore General（SF2 未压缩，兼容性最好）',
        license: 'MIT',
        installed: listSoundfontFiles().some((file) => file.name === 'MuseScore_General.sf2'),
      },
      {
        id: 'generaluser-gs',
        name: 'GeneralUser_GS.sf2',
        label: 'GeneralUser GS（轻量，音色均衡）',
        license: 'GeneralUser GS License (free)',
        installed: listSoundfontFiles().some((file) => file.name === 'GeneralUser_GS.sf2'),
      },
    ],
  }))
}
