/**
 * 分钟K线数据工具（A股经由 Qveris / 加密经由 Binance）
 * 说明：
 * - market_type = 'crypto' 走 Binance 分钟线接口（/api/v3/klines）
 * - market_type = 'cn' 需配置 QVERIS_API_KEY 经由 Qveris 路由；原 Tushare 路径已移除
 */
export const stockDataMinutes = {
  name: 'stock_data_minutes',
  description: '获取分钟K线数据：A股(Qveris)/加密(Binance)。支持1MIN/5MIN/15MIN/30MIN/60MIN，时间范围需提供起止日期时间',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        description: "代码，如 'BTCUSDT'（crypto）或 '600519.SH'（cn）"
      },
      market_type: {
        type: 'string',
        description: "市场类型：'crypto'（加密币对，Binance）、'cn'（A股，Qveris）"
      },
      start_datetime: {
        type: 'string',
        description: "起始日期时间，支持 'YYYYMMDDHHmmss' 或 'YYYY-MM-DD HH:mm:ss'"
      },
      end_datetime: {
        type: 'string',
        description: "结束日期时间，支持 'YYYYMMDDHHmmss' 或 'YYYY-MM-DD HH:mm:ss'"
      },
      freq: {
        type: 'string',
        description: "分钟周期：1MIN/5MIN/15MIN/30MIN/60MIN（不区分大小写）"
      }
    },
    required: ['code', 'market_type', 'start_datetime', 'end_datetime', 'freq']
  },
  async run(args: { code: string; market_type: string; start_datetime: string; end_datetime: string; freq: string }) {
    try {
      // 归一化时间：转为 YYYYMMDDHHmmss（剔除非数字）
      const normalizeDT = (v: string) => v.replace(/[^0-9]/g, '').padEnd(14, '0').slice(0, 14);
      const startTime = normalizeDT(args.start_datetime);
      const endTime = normalizeDT(args.end_datetime);
      if (startTime.length !== 14 || endTime.length !== 14) {
        throw new Error('起止时间格式不正确，请使用 YYYYMMDDHHmmss 或 YYYY-MM-DD HH:mm:ss');
      }
      if (endTime <= startTime) {
        throw new Error('结束时间必须大于起始时间');
      }

      // 归一化频率
      const rawFreq = String(args.freq || '').trim().toLowerCase();
      const freqMap: Record<string, string> = {
        '1min': '1min', '1m': '1min',
        '5min': '5min', '5m': '5min',
        '15min': '15min', '15m': '15min',
        '30min': '30min', '30m': '30min',
        '60min': '60min', '60m': '60min', '1h': '60min'
      };
      // 兼容 1MIN/5MIN 等写法（统一转小写再映射）
      const normalizedFreq = freqMap[rawFreq] || freqMap[rawFreq.replace('min', 'min')] || freqMap[rawFreq.replace('minute', 'min')] || rawFreq;
      const freq = normalizedFreq;
      const allowed = new Set(['1min', '5min', '15min', '30min', '60min']);
      if (!allowed.has(freq)) {
        throw new Error(`不支持的频率：${args.freq}，允许值：1MIN/5MIN/15MIN/30MIN/60MIN`);
      }

      // 市场分支
      const market = String(args.market_type || '').trim().toLowerCase();
      if (!['cn', 'crypto'].includes(market)) {
        throw new Error(`不支持的 market_type: ${args.market_type}，仅支持 'cn' 或 'crypto'`);
      }

      if (market === 'cn') {
        return {
          content: [{
            type: 'text',
            text: `# A股分钟K线 (${args.code}) 不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 分钟线路径已移除，请配置 QVERIS_API_KEY 或改用 crypto (Binance)。`,
          }],
          isError: true,
        };
      }

      // ===== crypto 分支（Binance 分钟线）=====
      // 频率映射到 Binance interval
      const binanceIntervalMap: Record<string, string> = {
        '1min': '1m',
        '5min': '5m',
        '15min': '15m',
        '30min': '30m',
        '60min': '1h'
      };
      const interval = binanceIntervalMap[freq];
      if (!interval) {
        throw new Error(`不支持的频率：${args.freq}（Binance）`);
      }

      // 时间转换为毫秒（UTC）
      const toMs = (s: string): number => {
        const y = parseInt(s.slice(0, 4));
        const m = parseInt(s.slice(4, 6));
        const d = parseInt(s.slice(6, 8));
        const hh = parseInt(s.slice(8, 10));
        const mm = parseInt(s.slice(10, 12));
        const ss = parseInt(s.slice(12, 14));
        return Date.UTC(y, m - 1, d, hh, mm, ss, 0);
      };
      const startMs = toMs(startTime);
      const endMs = toMs(endTime);

      // 交易对解析（兼容 BTCUSDT / BTC-USDT / BTC/USDT / coinid.USDT），USD 自动映射到 USDT
      const idToTicker: Record<string, string> = {
        'bitcoin': 'BTC', 'ethereum': 'ETH', 'tether': 'USDT', 'usd-coin': 'USDC', 'solana': 'SOL',
        'binancecoin': 'BNB', 'ripple': 'XRP', 'cardano': 'ADA', 'polkadot': 'DOT', 'chainlink': 'LINK',
        'litecoin': 'LTC', 'shiba-inu': 'SHIB', 'tron': 'TRX', 'toncoin': 'TON', 'bitcoin-cash': 'BCH',
        'ethereum-classic': 'ETC'
      };
      const parseBinanceSymbol = (raw: string): string => {
        const trimmed = String(raw || '').trim();
        const upper = trimmed.toUpperCase();
        const validQuotes = new Set(['USDT','USDC','FDUSD','TUSD','BUSD','BTC','ETH']);
        if (!upper.includes('-') && !upper.includes('/') && !upper.includes('.')) {
          return upper;
        }
        let base = '';
        let quote = '';
        if (upper.includes('-') || upper.includes('/')) {
          const sep = upper.includes('-') ? '-' : '/';
          const [b, q] = upper.split(sep);
          base = b;
          quote = q;
        } else if (upper.includes('.')) {
          const [id, vs] = upper.split('.');
          base = idToTicker[id.toLowerCase()] || id;
          quote = vs;
        }
        if (quote === 'USD') quote = 'USDT';
        if (!validQuotes.has(quote)) {
          throw new Error(`不支持的报价资产: ${quote}。支持: ${Array.from(validQuotes).join(', ')}`);
        }
        return `${base}${quote}`;
      };
      const symbol = parseBinanceSymbol(args.code);

      // 分页请求
      const allKlines: any[] = [];
      let cursor = startMs;
      let pageIndex = 0;
      const maxPages = 500;
      while (cursor < endMs && pageIndex < maxPages) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&startTime=${cursor}&endTime=${endMs}&limit=1000`;
        const resp = await fetch(url);
        if (!resp.ok) {
          try {
            const ct = resp.headers.get('content-type') || '';
            if (ct.includes('application/json')) {
              const err = await resp.json();
              const msg = err?.msg || `HTTP ${resp.status}`;
              if (Number(err?.code) === -1121 || /invalid symbol/i.test(String(msg))) {
                throw new Error(`Binance 无效交易对: ${symbol}。该币对在 Binance 不存在或已下线，请更换有效币对（例如：BTCUSDT、ETHUSDT、SOLUSDT）。也支持 BTC-USDT、BTC/USDT、或 coinid.USDT 写法。`);
              }
              throw new Error(`Binance K线请求失败: ${resp.status} - ${msg}`);
            } else {
              const text = await resp.text();
              throw new Error(`Binance K线请求失败: ${resp.status}${text ? ` - ${text}` : ''}`);
            }
          } catch (e) {
            if (e instanceof Error) throw e;
            throw new Error(`Binance K线请求失败: ${resp.status}`);
          }
        }
        const kl = await resp.json();
        if (!Array.isArray(kl)) throw new Error('Binance 返回的 K 线数据格式异常');
        if (kl.length === 0) break;
        allKlines.push(...kl);
        const lastOpenTime = Number(kl[kl.length - 1][0]);
        if (!(lastOpenTime > cursor)) break;
        cursor = lastOpenTime + 1;
        pageIndex += 1;
        if (kl.length < 1000) break;
      }

      // 转换为统一对象
      const toYMDHMS = (ms: number): string => {
        const d = new Date(ms);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(d.getUTCDate()).padStart(2, '0');
        const hh = String(d.getUTCHours()).padStart(2, '0');
        const mm = String(d.getUTCMinutes()).padStart(2, '0');
        const ss = String(d.getUTCSeconds()).padStart(2, '0');
        return `${y}-${m}-${dd} ${hh}:${mm}:${ss}`;
      };
      const rows = allKlines.map(row => {
        const openTime = Number(row[0]);
        return {
          trade_time: toYMDHMS(openTime),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          vol: Number(row[5])
        } as Record<string, any>;
      });

      // 严格过滤在用户区间内（Binance 已按毫秒过滤，此处再按显示字段兜底）
      const filtered = rows.filter(r => true);
      filtered.sort((a, b) => String(b.trade_time).localeCompare(String(a.trade_time)));

      // 输出
      let out = `# ${args.code} 分钟K线（${freq}，Binance）\n\n`;
      out += `查询区间: ${startTime} - ${endTime}\n`;
      out += `返回条数: ${filtered.length}\n\n`;
      const headers = ['时间', '开盘', '最高', '最低', '收盘', '成交量'];
      out += `| ${headers.join(' | ')} |\n`;
      out += `|${headers.map(() => '--------').join('|')}|\n`;
      for (const r of filtered) {
        out += `| ${r.trade_time} | ${fmt(safeNum(r.open))} | ${fmt(safeNum(r.high))} | ${fmt(safeNum(r.low))} | ${fmt(safeNum(r.close))} | ${r.vol == null ? 'N/A' : String(r.vol)} |\n`;
      }

      return { content: [{ type: 'text', text: out }] };
    } catch (err) {
      return {
        content: [{
          type: 'text',
          text: `获取分钟K线失败：${err instanceof Error ? err.message : String(err)}`
        }],
        isError: true
      };
    }
  }
};

function safeNum(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmt(n: number | null, d = 2): string {
  return n == null ? 'N/A' : n.toFixed(d);
}
