import { describe, expect, it, vi } from 'vitest'
import { doubaoExpiry } from '../../src/aggregate-expiry.js'
import { NEVER, UNUSABLE, rankCandidates } from '../../src/aggregate-core.js'
import { buildVirtualModels } from '../../src/aggregate-catalog.js'
import { canonicalDisplayName, canonicalKeyFor } from '../../src/canonical-models.js'
import type { CreditBalance } from '../../src/credits.js'
import { DOUBAO_FALLBACK_MODELS, DoubaoAdapter } from '../../src/doubao-adapter.js'
import { doubaoTagSuffix } from '../../src/doubao-upstream.js'

const credential = { cookie: 'sessionid=fake-agg; ttwid=x' }

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch
}

describe('doubaoExpiry（豆包临期额度折算）', () => {
  it('扣费包有唯一 end_time 且 remaining > 0 时返回真实到期时间戳', async () => {
    const endMs = 1_797_937_149_723
    const fetchImpl = jsonFetch({
      code: 0,
      data: {
        quota_balance_overview: {
          total_remaining_amount: '1,000',
          summaries: [{ category: 1, title: '套餐', remaining_amount: '1,000' }],
        },
        window_limit_section: {
          window_limit_groups: [
            {
              feature_group: 'membership',
              window_limits: [{ total_amount: '1,000', used_amount: '0', end_time: endMs }],
            },
          ],
        },
      },
    })

    expect(await doubaoExpiry(credential, undefined, fetchImpl)).toBe(endMs)
  })

  it('仅有多个不同 end_time 或无 end_time 的可用余额包时返回 NEVER（不编造假过期时间）', async () => {
    const endA = 1_797_937_149_723
    const fetchMixed = jsonFetch({
      code: 0,
      data: {
        quota_balance_overview: {
          total_remaining_amount: '1,000',
          summaries: [{ category: 1, title: '套餐', remaining_amount: '1,000' }],
        },
        window_limit_section: {
          window_limit_groups: [
            {
              feature_group: 'membership',
              window_limits: [
                { total_amount: '600', used_amount: '0', end_time: endA },
                { total_amount: '400', used_amount: '0', end_time: endA + 86_400_000 },
              ],
            },
          ],
        },
      },
    })
    expect(await doubaoExpiry(credential, undefined, fetchMixed)).toBe(NEVER)

    const fetchUnknown = jsonFetch({
      code: 0,
      data: {
        quota_balance_overview: {
          total_remaining_amount: '500',
          summaries: [{ category: 3, title: '赠送', remaining_amount: '500' }],
        },
      },
    })
    expect(await doubaoExpiry(credential, undefined, fetchUnknown)).toBe(NEVER)
  })

  it('额度耗尽、上游异常或未导入 Cookie 时返回 UNUSABLE', async () => {
    const fetchZero = jsonFetch({
      code: 0,
      data: {
        quota_balance_overview: {
          total_remaining_amount: '0',
          summaries: [{ category: 1, title: '套餐', remaining_amount: '0' }],
        },
      },
    })
    expect(await doubaoExpiry(credential, undefined, fetchZero)).toBe(UNUSABLE)

    const fetchError = jsonFetch({ message: 'upstream error' }, 500)
    expect(await doubaoExpiry(credential, undefined, fetchError)).toBe(UNUSABLE)

    const fetchEmptyCookie = jsonFetch({ code: 0, data: {} })
    expect(await doubaoExpiry({}, undefined, fetchEmptyCookie)).toBe(UNUSABLE)
    expect(fetchEmptyCookie).not.toHaveBeenCalled()
  })

  it('cached 命中有效 CreditBalance 时直接采用缓存且不发起网络请求', async () => {
    const cachedExpiry = 1_800_000_000_000
    const fetchImpl = jsonFetch({ code: 0, data: {} })
    const cachedBalance: CreditBalance = {
      packages: [
        {
          total: 1000,
          remaining: 800,
          active: true,
          deductionEndTime: cachedExpiry,
        },
      ],
    }

    const result = await doubaoExpiry(credential, async () => cachedBalance, fetchImpl)
    expect(result).toBe(cachedExpiry)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('豆包全量模型规范键归并、跨渠道合并与倍率排序', () => {
  const EXPECTED_KEYS: Record<string, string> = {
    '0': 'doubao-fast',
    '3': 'doubao-expert',
    '9': 'doubao-auto',
    'seed-lite-7b': 'doubao-2-1-lite',
    '5': 'doubao-2-1-pro',
    'person-deepseek-v4-1-flash-261017': 'deepseek-v4-1-flash',
    'person-deepseek-v4-pro-ga-260813': 'deepseek-v4-pro',
    'person-glm-5-3-261111': 'glm-5-3',
    'person-glm-5-3-flash-261111': 'glm-5-3-flash',
    'person-glm-5-4': 'glm-5-4',
    'person-qwen3-8-max': 'qwen3-8-max',
    'person-qwen3-8-flash': 'qwen3-8-flash',
    'person-qwen4-max': 'qwen4-max',
    'person-kimi-k3-261111': 'kimi-k3',
    'person-kimi-k3-1-pro-261111': 'kimi-k3-1-pro',
    'person-kimi-k3-1-pro-highspeed-261111': 'kimi-k3-1-pro-highspeed',
    'person-mimo-v2-6-pro': 'mimo-v2-6-pro',
    'person-mimo-v2-6-flash': 'mimo-v2-6-flash',
  }

  it('全部 15 个兜底模型 + 3 个远端实测模型均命中显式补丁且具备正式展示名', () => {
    const allModels = [
      ...DOUBAO_FALLBACK_MODELS.map((m) => ({
        id: m.key,
        name: (() => {
          const suffix = doubaoTagSuffix(m.tags)
          return suffix ? `${m.name} · ${suffix}` : m.name
        })(),
      })),
      { id: 'person-glm-5-4', name: 'GLM 5.4 · 新上线 0.80x' },
      { id: 'person-mimo-v2-6-pro', name: 'MiMo V2.6 Pro · 0.50x' },
      { id: 'person-mimo-v2-6-flash', name: 'MiMo V2.6 Flash · 0.05x' },
    ]

    expect(allModels).toHaveLength(18)
    for (const model of allModels) {
      const mapped = canonicalKeyFor('doubao', model.id, model.name)
      expect(mapped, `${model.id} 必须命中显式规范键映射`).toEqual({
        key: EXPECTED_KEYS[model.id],
        via: 'patch',
      })
      const display = canonicalDisplayName(mapped!.key)
      expect(display.trim().length, `${mapped!.key} 展示名不得为空`).toBeGreaterThan(0)
      expect(display).not.toMatch(/^\d+$/)
      expect(display).not.toContain('person-')
    }
  })

  it('跨渠道构建虚拟模型时与 buddy / magicrew / lobsterai 正确合并，并按倍率排在前面', async () => {
    const adapter = new DoubaoAdapter({
      credentialRef: 'DOUBAO_SPEC',
      slots: async () => [],
    })
    const doubaoModels = await adapter.listModels('doubao')
    const vms = buildVirtualModels({
      doubao: [
        ...doubaoModels,
        { id: 'person-mimo-v2-6-pro', name: 'MiMo V2.6 Pro · x0.50' },
      ],
      buddy: [
        { id: 'glm-5.3', name: 'GLM 5.3 · x1.50' },
      ],
      magicrew: [
        { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro · x2.0' },
      ],
      lobsterai: [
        { id: 'qwen4-max', name: 'Qwen 4 Max · x1.0' },
      ],
    })

    const byKey = new Map(vms.map((vm) => [vm.key, vm]))

    expect(byKey.get('glm-5-3')?.candidates.map((c) => c.provider)).toEqual(['buddy', 'doubao'])
    expect(byKey.get('mimo-v2-6-pro')?.candidates.map((c) => c.provider)).toEqual(['doubao', 'magicrew'])
    expect(byKey.get('qwen4-max')?.candidates.map((c) => c.provider)).toEqual(['doubao', 'lobsterai'])

    const doubaoLite = byKey.get('doubao-2-1-lite')?.candidates[0]
    expect(doubaoLite?.realName).toBe('豆包 2.1 Lite · 限时优惠 · x0.01')
    expect(doubaoLite?.price).toBe(0.01)

    const ranked = rankCandidates([
      { provider: 'buddy', realId: 'glm-5.3', expiry: NEVER, price: byKey.get('glm-5-3')!.candidates[0]!.price },
      { provider: 'doubao', realId: 'person-glm-5-3-261111', expiry: NEVER, price: byKey.get('glm-5-3')!.candidates[1]!.price },
    ])
    expect(ranked.map((c) => c.provider)).toEqual(['doubao', 'buddy'])
  })
})
