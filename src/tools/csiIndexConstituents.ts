export const csiIndexConstituents = {
  name: 'csi_index_constituents',
  description: '获取中证指数公司(CSI)指数（含行业/主题）的区间行情、成分权重与估值/财务摘要（通过 Qveris 路由）。',
  parameters: {
    type: 'object',
    properties: {
      index_code: {
        type: 'string',
        description: "指数代码(仅限CSI，含行业/主题)，例如中证证券公司 '399975.SZ'、沪深300 '000300.SH'、中证500 '000905.SH'。",
      },
      start_date: {
        type: 'string',
        description: '开始日期，YYYYMMDD 或 YYYY-MM-DD',
      },
      end_date: {
        type: 'string',
        description: '结束日期，YYYYMMDD 或 YYYY-MM-DD',
      },
    },
    required: ['index_code', 'start_date', 'end_date'],
  },
  async run(args: { index_code: string; start_date: string; end_date: string }) {
    return {
      content: [{
        type: 'text',
        text: `# 中证指数成分与估值 (${args.index_code}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置 QVERIS_API_KEY 后通过 Qveris 数据源调用。`,
      }],
      isError: true,
    };
  },
};
