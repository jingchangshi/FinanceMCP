export const hotNews = {
  name: 'hot_news_7x24',
  description: '7x24热点：按当前数据源优先级获取最新新闻（通过 Twingly 或 Qveris 路由）；Twingly 单次上限250条',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: '返回条数，默认100；Twingly 上限250，实际限制取决于当前首选数据源',
        minimum: 1,
        maximum: 1500,
      },
    },
  },
  async run(_args?: { limit?: number }) {
    return {
      content: [{
        type: 'text',
        text: '# 7x24 热点不可用\n\n未配置 TWINGLY_API_KEY 或 QVERIS_API_KEY。原 Tushare 原生路径已移除，请配置可用新闻数据源凭证。',
      }],
      isError: true,
    };
  },
};
