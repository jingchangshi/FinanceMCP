import {
  MACRO_INDICATORS,
  InvalidToolInputError,
  normalizeEnumInput,
  normalizeOptionalDate,
} from '../utils/inputValidation.js';

export const macroEcon = {
  name: 'macro_econ',
  description: '获取宏观经济数据（通过 Qveris 路由），包括Shibor利率、LPR利率、GDP、CPI、PPI、货币供应量、PMI、社融数据、Shibor报价、Libor、Hibor等',
  parameters: {
    type: 'object',
    properties: {
      indicator: {
        type: 'string',
        enum: [...MACRO_INDICATORS],
        description: '指标类型，可选值：shibor(上海银行间同业拆放利率)、lpr(贷款市场报价利率)、gdp(国内生产总值)、cpi(居民消费价格指数)、ppi(工业生产者出厂价格指数)、cn_m(货币供应量)、cn_pmi(采购经理指数)、cn_sf(社会融资规模)、shibor_quote(Shibor银行报价数据)、libor(伦敦银行间同业拆借利率)、hibor(香港银行间同业拆借利率)',
      },
      start_date: {
        type: 'string',
        description: "起始日期，格式为YYYYMMDD，如'20230101'",
      },
      end_date: {
        type: 'string',
        description: "结束日期，格式为YYYYMMDD，如'20230131'",
      },
    },
    required: ['indicator', 'start_date', 'end_date'],
  },
  async run(args: { indicator: string; start_date?: string; end_date?: string }) {
    try {
      const indicator = normalizeEnumInput(args.indicator, MACRO_INDICATORS, 'indicator');
      normalizeOptionalDate(args.start_date, 'start_date');
      normalizeOptionalDate(args.end_date, 'end_date');
      return {
        content: [{
          type: 'text',
          text: `# 宏观经济数据 (${indicator}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置 QVERIS_API_KEY 后通过 Qveris 数据源调用。`,
        }],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof InvalidToolInputError
        ? '输入参数无效，请检查宏观指标名称与日期范围。'
        : '暂时无法获取宏观经济数据，请稍后重试。';
      return {
        content: [{ type: 'text', text: `# 获取宏观经济数据失败\n\n${message}` }],
        isError: true,
      };
    }
  },
};
