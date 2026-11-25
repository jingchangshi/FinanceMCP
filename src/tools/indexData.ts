import {
  INDEX_DATA_TYPES,
  InvalidToolInputError,
  normalizeFinancialCode,
  normalizeOptionalDate,
  normalizeOptionalEnumInput,
} from '../utils/inputValidation.js';

export const indexData = {
  name: 'index_data',
  description: '获取指定股票指数的数据（通过 Qveris 路由），支持日线/周线/月线行情、国际主要指数、指数基本信息和估值指标',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        maxLength: 32,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$',
        description: "指数代码，如'000001.SH'表示上证指数，'399001.SZ'表示深证成指",
      },
      start_date: {
        type: 'string',
        description: "起始日期，格式为YYYYMMDD，如'20230101'（data_type=daily/valuation时有效）",
      },
      end_date: {
        type: 'string',
        description: "结束日期，格式为YYYYMMDD，如'20230131'（data_type=daily/valuation时有效）",
      },
      data_type: {
        type: 'string',
        description: '数据类型：daily(日线行情，默认)、weekly(周线行情)、monthly(月线行情)、global(国际主要指数日线)、basic(指数基本信息)、valuation(估值指标-市盈率/市净率/换手率/总市值等)',
        enum: ['daily', 'weekly', 'monthly', 'global', 'basic', 'valuation'],
      },
    },
    required: ['code'],
  },
  async run(args: { code: string; start_date?: string; end_date?: string; data_type?: string }) {
    try {
      const code = normalizeFinancialCode(args.code, { maxLength: 32 });
      normalizeOptionalDate(args.start_date, 'start_date');
      normalizeOptionalDate(args.end_date, 'end_date');
      normalizeOptionalEnumInput(args.data_type, INDEX_DATA_TYPES, 'data_type');
      return {
        content: [{
          type: 'text',
          text: `# 指数数据 (${code}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置 QVERIS_API_KEY 后通过 Qveris 数据源调用。`,
        }],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof InvalidToolInputError
        ? '输入参数无效，请按支持格式提交指数代码与日期范围。'
        : '暂时无法获取指数数据，请稍后重试。';
      return {
        content: [{ type: 'text', text: `# 获取指数数据失败\n\n${message}` }],
        isError: true,
      };
    }
  },
};
