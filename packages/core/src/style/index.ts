/**
 * 风格层：把「语料学到的统计」变成生成器可直接消费的采样函数。
 *
 * 对外只暴露纯数据 + 纯函数；IO（读 `data/corpus/profiles/*.json`）在服务端。
 */
export * from './profile.js'
export * from './humanize.js'
