export const companyPerformance = {
  name: 'company_performance',
  description: '获取上市公司综合表现数据（通过 Qveris 路由），包括业绩预告、业绩快报、财务指标、分红送股、主营业务构成、股东变动数据、资产负债表、现金流量表、利润表等',
  parameters: {
    type: 'object',
    properties: {
      ts_code: {
        type: 'string',
        description: "股票代码，如'000001.SZ'表示平安银行，'600000.SH'表示浦发银行",
      },
      data_type: {
        type: 'string',
        description: '数据类型：forecast/express/indicators/dividend/mainbz/holder_number/holder_trade/managers/audit/company_basic/balance_basic/balance_all/cashflow_basic/cashflow_all/income_basic/income_all/share_float/repurchase/top10_holders/top10_floatholders/pledge_stat/pledge_detail/daily_basic/stk_basic/ipo',
        enum: [
          'forecast', 'express', 'indicators', 'dividend', 'mainbz', 'holder_number', 'holder_trade',
          'managers', 'audit', 'company_basic', 'balance_basic', 'balance_all', 'cashflow_basic',
          'cashflow_all', 'income_basic', 'income_all', 'share_float', 'repurchase', 'top10_holders',
          'top10_floatholders', 'pledge_stat', 'pledge_detail', 'daily_basic', 'stk_basic', 'ipo',
        ],
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
    required: ['data_type'],
  },
  async run(args: {
    ts_code?: string;
    data_type: string;
    start_date?: string;
    end_date?: string;
    period?: string;
  }) {
    return {
      content: [{
        type: 'text',
        text: `# 公司综合表现 (${args.data_type}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置 QVERIS_API_KEY 后通过 Qveris 数据源调用。`,
      }],
      isError: true,
    };
  },
};
