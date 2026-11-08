import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/api'
import { streamSceneDraft, streamScenePlan, type ScenePlan, type SceneResult } from './scene'

const plan: ScenePlan = { goal: '找到信封', withheld: '信封主人', pov: '第三人称限知', ending: '听见敲门声', targetChars: 600 }
const result: SceneResult = {
  plan, draft: '雨夜，门开了。', revised: '雨夜，门开了。', repairApplied: false, warnings: [], findings: [{
    id: 'f1', kind: 'pov', severity: 'conflict', constraintId: 'pov', constraint: '第三人称限知', quote: '门开了', start: 3, end: 6,
    reason: '视角可能越界', suggestion: '限于主角所见', repairable: true,
  }], metrics: { durationMs: 1, requestCount: 2, attemptCount: 2, usage: { status: 'unknown', knownInputTokens: 0, knownOutputTokens: 0 } },
}
const request = { book_id: 'book-1', chapter_id: 'chapter-1', content: '已有正文', intent: '写一场雨夜重逢', model: 'local/device/model' }
const frame = (type: string, data: unknown = {}) => `data: ${JSON.stringify({ type, data })}\r\n\r\n`
const terminal = (data: unknown) => frame('result', data) + frame('done') + 'data: [DONE]\r\n\r\n'
function respond(raw: string, split = 0) {
  const bytes = new TextEncoder().encode(raw)
  return new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += split || bytes.length) controller.enqueue(bytes.slice(offset, offset + (split || bytes.length)))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
const draft = (signal = new AbortController().signal, onProgress = vi.fn()) => streamSceneDraft({ ...request, plan, auto_repair: false }, signal, onProgress)
let originalBase: string | undefined
beforeEach(() => {
  originalBase = api.defaults.baseURL
  vi.stubGlobal('localStorage', { getItem: vi.fn((key: string) => key === 'token' ? 'jwt' : null) })
})
afterEach(() => { api.defaults.baseURL = originalBase; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('scene streaming API', () => {
  it('uses configured API base and auth, preserves split unicode/CRLF, and returns only after result plus done', async () => {
    api.defaults.baseURL = 'https://example.test/api/'
    const progress = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue(respond(': heartbeat\r\n\r\n' + frame('stage', { stage: 'context' })
      + frame('stage', { stage: 'draft' }) + frame('token', { text: '雨夜🌧，门开了。' }) + frame('stage', { stage: 'review' }) + terminal(result), 1))
    vi.stubGlobal('fetch', fetchMock)
    expect(await draft(undefined, progress)).toEqual(result)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.test/api/ai/scene/stream')
    const options = fetchMock.mock.calls[0][1]
    expect(options.headers.Authorization).toBe('Bearer jwt')
    expect(JSON.parse(options.body)).toEqual({ ...request, plan, auto_repair: false })
    expect(progress.mock.calls.map(([event]) => event)).toEqual([
      { type: 'stage', data: { stage: 'context' } }, { type: 'stage', data: { stage: 'draft' } },
      { type: 'token', data: { text: '雨夜🌧，门开了。' } }, { type: 'stage', data: { stage: 'review' } },
    ])
  })

  it('supports multiline data and a final sentinel without a newline', async () => {
    const prettyResult = JSON.stringify({ type: 'result', data: { plan } }, null, 2).split('\n').map(line => `data: ${line}`).join('\r\n')
    const fetchMock = vi.fn().mockResolvedValue(respond(frame('stage', { stage: 'plan' }) + prettyResult + '\r\n\r\n' + frame('done') + 'data: [DONE]', 3))
    vi.stubGlobal('fetch', fetchMock)
    expect(await streamScenePlan(request, new AbortController().signal)).toEqual({ plan })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/ai/scene/plan/stream')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(request)
  })

  it.each([
    ['only sentinel', 'data: [DONE]\n\n'],
    ['only done', frame('done')],
    ['result but no done', frame('result', result) + 'data: [DONE]\n\n'],
    ['EOF after result', frame('result', result)],
    ['missing sentinel after done', frame('result', result) + frame('done')],
    ['partial draft', frame('stage', { stage: 'draft' }) + frame('token', { text: '半篇' })],
    ['bad JSON', 'data: {invalid}\n\n'],
    ['invalid result', terminal({ plan, draft: '少了字段' })],
    ['bad evidence', terminal({ ...result, findings: [{ ...result.findings[0], quote: '不存在的原句' }] })],
    ['wrong stage', frame('stage', { stage: 'plan' }) + terminal(result)],
    ['token outside draft', frame('stage', { stage: 'review' }) + frame('token', { text: '不能是修订过程稿' }) + terminal(result)],
    ['duplicate result', frame('result', result) + terminal(result)],
    ['late error', frame('result', result) + frame('done') + frame('error', { message: '<script>private internal error</script>' })],
  ])('rejects %s without returning a usable result', async (_name, raw) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(raw, 7)))
    await expect(draft()).rejects.toThrow(/场景/)
  })

  it('keeps a terminal result private until done and the sentinel arrive', async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller } }), { headers: { 'content-type': 'text/event-stream' } })))
    const settled = vi.fn()
    const pending = draft().then(value => { settled(value); return value })
    stream.enqueue(new TextEncoder().encode(frame('result', result)))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(settled).not.toHaveBeenCalled()
    stream.enqueue(new TextEncoder().encode(frame('done')))
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(settled).not.toHaveBeenCalled()
    stream.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
    expect(await pending).toEqual(result)
    expect(settled).toHaveBeenCalledOnce()
  })

  it.each([
    ['incomplete plan', frame('result', { plan })],
    ['invalid target', terminal({ plan: { ...plan, targetChars: 1601 } })],
    ['empty goal', terminal({ plan: { ...plan, goal: ' ' } })],
    ['draft token in plan', frame('token', { text: '正文' }) + terminal({ plan })],
  ])('rejects %s from planning', async (_name, raw) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(raw)))
    await expect(streamScenePlan(request, new AbortController().signal)).rejects.toThrow(/场景/)
  })

  it('does not disclose arbitrary server errors, HTML pages, or fetch exception details', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('secret details'.repeat(1000), { status: 500 }))
      .mockResolvedValueOnce(new Response('<html>secret details</html>', { headers: { 'content-type': 'text/html' } }))
      .mockResolvedValueOnce(respond(frame('error', { message: 'secret details'.repeat(1000) })))
      .mockRejectedValueOnce(new Error('secret details'))
    vi.stubGlobal('fetch', fetchMock)
    for (let index = 0; index < 4; index++) {
      const failure = await draft().catch(error => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message.length).toBeLessThan(100)
      expect((failure as Error).message).not.toContain('secret')
    }
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    [400, '检查意图、目标和字数'],
    [404, '重新选择章节'],
  ])('provides actionable HTTP %s errors without echoing response bodies', async (status, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private internal error', { status })))
    await expect(draft()).rejects.toThrow(expected)
  })

  it.each([
    ['AI 服务调用失败: 当前任务资料估算需要 35000 tokens，超过可用输入预算 27648；请缩小待处理范围或减少背景资料后重试。', '超过模型输入预算'],
    ['AI 服务调用失败: 场景任务返回的结构无法解析，请重试；未生成可应用结果', '响应格式异常'],
    ['AI 服务调用失败: 本机连接器已离线，请在电脑上重新连接', '手动选择其他模型'],
    ['本机模型已不可用，请刷新模型列表', '重新选择模型'],
    ['AI 服务调用失败: AI 输出达到长度上限，结果不完整，请缩小范围后重试', '降低目标字数'],
  ])('maps allowlisted errors to bounded guidance', async (message, expected) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(frame('error', { message }))))
    await expect(draft()).rejects.toThrow(expected)
  })

  it('does not echo upstream text that merely contains an allowlisted message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(frame('error', { message: 'AI 服务调用失败: 本机连接器已离线，请在电脑上重新连接 private details' }))))
    await expect(draft()).rejects.toThrow('场景生成失败，请重试；部分内容不可使用。')
  })

  it('rejects oversized frames and releases the reader', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: ' + 'x'.repeat(1_000_001)))
    }, cancel }), { headers: { 'content-type': 'text/event-stream' } })))
    await expect(draft()).rejects.toThrow('格式异常')
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels an in-flight read on abort and never resolves its draft', async () => {
    const controller = new AbortController()
    const cancel = vi.fn()
    const progress = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(stream) {
      stream.enqueue(new TextEncoder().encode(frame('stage', { stage: 'draft' }) + frame('token', { text: '部分正文' })))
    }, cancel }), { headers: { 'content-type': 'text/event-stream' } })))
    const pending = draft(controller.signal, progress)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await vi.waitFor(() => expect(progress).toHaveBeenCalledTimes(2))
    controller.abort()
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('does not start aborted requests and cancels a late response after abort', async () => {
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(draft(controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
    const next = new AbortController()
    const cancel = vi.fn()
    let resolve!: (response: Response) => void
    fetchMock.mockImplementation(() => new Promise<Response>(done => { resolve = done }))
    const pending = draft(next.signal)
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    next.abort()
    resolve(new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'text/event-stream' } }))
    await rejected
    expect(cancel).toHaveBeenCalledOnce()
  })
})
