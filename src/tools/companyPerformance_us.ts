export const companyPerformance_us = {
  name: 'company_performance_us',
  description: '获取美股上市公司综合表现数据（通过 Qveris 路由），包括利润表、资产负债表、现金流量表和财务指标数据',
  parameters: {
    type: 'object',
    properties: {
      ts_code: {
        type: 'string',
        description: "美股代码，如'NVDA'表示英伟达，'AAPL'表示苹果，'TSLA'表示特斯拉",
      },
      data_type: {
        type: 'string',
        description: '数据类型：income(利润表)、balance(资产负债表)、cashflow(现金流量表)、indicator(财务指标)',
        enum: ['income', 'balance', 'cashflow', 'indicator'],
      },
      start_date: {
        type: 'string',
        description: "起始日期，格式为YYYYMMDD，如'20230101'",
      },
      end_date: {
        type: 'string',
        description: "结束日期，格式为YYYYMMDD，如'20231231'",
      },
      period: {
        type: 'string',
        description: "特定报告期，格式为YYYYMMDD，如'20231231'表示2023年年报",
      },
    },
    required: ['ts_code', 'data_type', 'start_date', 'end_date'],
  },
  async run(args: {
    ts_code: string;
    data_type: string;
    start_date: string;
    end_date: string;
    period?: string;
  }) {
    return {
      content: [{
        type: 'text',
        text: `# 美股公司综合表现 (${args.ts_code}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置 QVERIS_API_KEY 后通过 Qveris 数据源调用。`,
      }],
      isError: true,
    };
  },
};
