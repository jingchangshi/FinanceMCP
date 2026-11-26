import {
  InvalidToolInputError,
  STOCK_MARKET_TYPES,
  normalizeEnumInput,
  normalizeFinancialCode,
  normalizeOptionalDate,
  normalizeOptionalEnumInput,
  normalizeOptionalIndicatorList,
} from '../utils/inputValidation.js';

import {
  calculateMACD,
  calculateKDJ,
  calculateRSI,
  calculateBOLL,
  calculateSMA,
  parseIndicatorParams,
  formatIndicatorParams,
  calculateRequiredDays,
  calculateExtendedStartDate,
  filterRowsAndIndicators,
} from './stockDataDetail/index.js';

export const stockData = {
  name: 'stock_data',
  description: '获取指定股票/加密资产的历史行情数据（加密货币直接走 Binance，股票等市场通过 Qveris 路由）',
  parameters: {
    type: 'object',
    properties: {
      code: {
        type: 'string',
        maxLength: 40,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{0,39}$',
        description: "股票/合约/加密资产代码。股票示例：'000001.SZ'(A股平安银行)、'AAPL'(美股)、'00700.HK'(港股)。加密示例(需 market_type=crypto，Binance)：推荐 'BTCUSDT'、'ETHUSDT'、'USDCUSDT' 等，也兼容 'BTC-USDT' 或 'BTC/USDT'。",
      },
      market_type: {
        type: 'string',
        enum: [...STOCK_MARKET_TYPES],
        description: '市场类型（必需），可选值：cn(A股),us(美股),hk(港股),fx(外汇),futures(期货),fund(基金),repo(债券逆回购),convertible_bond(可转债),options(期权),crypto(加密货币/Binance)',
      },
      start_date: {
        type: 'string',
        description: "起始日期，格式为YYYYMMDD，如'20230101'",
      },
      end_date: {
        type: 'string',
        description: "结束日期，格式为YYYYMMDD，如'20230131'",
      },
      indicators: {
        type: 'string',
        description: "需要计算的技术指标，多个指标用空格分隔。支持的指标：macd/rsi/kdj/boll/ma，如 'macd(12,26,9) rsi(14)'",
      },
      timeframe: {
        type: 'string',
        enum: ['daily', 'weekly', 'monthly'],
        description: 'K线周期，可选值：daily(日线，默认)、weekly(周线)、monthly(月线)。',
      },
    },
    required: ['code', 'market_type'],
  },
  async run(args: { code: string; market_type: string; start_date?: string; end_date?: string; indicators?: string; timeframe?: string }) {
    try {
      const marketType = normalizeEnumInput(args.market_type, STOCK_MARKET_TYPES, 'market_type');
      const code = normalizeFinancialCode(args.code, { allowSlash: marketType === 'crypto' });
      args = {
        ...args,
        code,
        market_type: marketType,
        start_date: normalizeOptionalDate(args.start_date, 'start_date'),
        end_date: normalizeOptionalDate(args.end_date, 'end_date'),
        indicators: normalizeOptionalIndicatorList(args.indicators),
        timeframe: normalizeOptionalEnumInput(args.timeframe, ['daily', 'weekly', 'monthly'] as const, 'timeframe'),
      };

      const requestedIndicators = args.indicators ? args.indicators.trim().split(/\s+/) : [];
      const today = new Date();
      const defaultEndDate = today.toISOString().slice(0, 10).replace(/-/g, '');
      const oneMonthAgo = new Date();
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
      const defaultStartDate = oneMonthAgo.toISOString().slice(0, 10).replace(/-/g, '');
      const userStartDate = args.start_date || defaultStartDate;
      const userEndDate = args.end_date || defaultEndDate;

      let actualStartDate = userStartDate;
      if (requestedIndicators.length > 0) {
        const requiredDays = calculateRequiredDays(requestedIndicators);
        actualStartDate = calculateExtendedStartDate(userStartDate, requiredDays);
      }

      if (marketType === 'crypto') {
        const toYMD = (d: Date): string => {
          const y = d.getUTCFullYear();
          const m = String(d.getUTCMonth() + 1).padStart(2, '0');
          const day = String(d.getUTCDate()).padStart(2, '0');
          return `${y}${m}${day}`;
        };
        const ymdToStartMs = (s: string): number => Date.UTC(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, parseInt(s.slice(6, 8)), 0, 0, 0, 0);
        const ymdToEndMs = (s: string): number => Date.UTC(parseInt(s.slice(0, 4)), parseInt(s.slice(4, 6)) - 1, parseInt(s.slice(6, 8)), 23, 59, 59, 999);

        const idToTicker: Record<string, string> = {
          bitcoin: 'BTC', ethereum: 'ETH', tether: 'USDT', 'usd-coin': 'USDC', solana: 'SOL',
          binancecoin: 'BNB', ripple: 'XRP', cardano: 'ADA', polkadot: 'DOT', chainlink: 'LINK',
          litecoin: 'LTC', 'shiba-inu': 'SHIB', tron: 'TRX', toncoin: 'TON', 'bitcoin-cash': 'BCH',
          'ethereum-classic': 'ETC',
        };

        const parseBinanceSymbol = (raw: string): string => {
          const upper = raw.trim().toUpperCase();
          const validQuotes = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'BUSD', 'BTC', 'ETH']);
          if (!upper.includes('-') && !upper.includes('/') && !upper.includes('.')) return upper;
          let base = '';
          let quote = '';
          if (upper.includes('-') || upper.includes('/')) {
            const sep = upper.includes('-') ? '-' : '/';
            [base, quote] = upper.split(sep);
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
        const startYmd = requestedIndicators.length > 0 ? actualStartDate : userStartDate;
        let startMs = ymdToStartMs(startYmd);
        const endMs = ymdToEndMs(userEndDate);
        const allKlines: any[] = [];
        let pageIndex = 0;
        const maxPages = 100;
        while (startMs < endMs && pageIndex < maxPages) {
          const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1d&startTime=${startMs}&endTime=${endMs}&limit=1000`;
          const resp = await fetch(url);
          if (!resp.ok) {
            const contentType = resp.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
              const errJson: any = await resp.json();
              const errMsg = errJson?.msg || `HTTP ${resp.status}`;
              if (Number(errJson?.code) === -1121 || /invalid symbol/i.test(String(errMsg))) {
                throw new Error(`Binance 无效交易对: ${symbol}。`);
              }
              throw new Error(`Binance K线请求失败: ${resp.status} - ${errMsg}`);
            }
            throw new Error(`Binance K线请求失败: ${resp.status}`);
          }
          const klines: any[] = await resp.json();
          if (!Array.isArray(klines)) throw new Error('Binance 返回的 K 线数据格式异常');
          if (klines.length === 0) break;
          allKlines.push(...klines);
          const lastOpenTime = Number(klines[klines.length - 1][0]);
          if (!(lastOpenTime > startMs)) break;
          startMs = lastOpenTime + 1;
          pageIndex += 1;
          if (klines.length < 1000) break;
        }

        let rows = allKlines.map(row => ({
          trade_date: toYMD(new Date(Number(row[0]))),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          vol: Number(row[5]),
        })) as Record<string, any>[];
        if (requestedIndicators.length === 0) {
          rows = rows.filter(r => r.trade_date >= userStartDate && r.trade_date <= userEndDate);
        }
        rows.sort((a, b) => b.trade_date.localeCompare(a.trade_date));

        const indicators: Record<string, any> = {};
        if (requestedIndicators.length > 0) {
          const closes = rows.map(d => parseFloat(d.close)).reverse();
          const highs = rows.map(d => parseFloat(d.high)).reverse();
          const lows = rows.map(d => parseFloat(d.low)).reverse();
          for (const indicator of requestedIndicators) {
            const { name, params } = parseIndicatorParams(indicator);
            switch (name) {
              case 'macd':
                if (params.length !== 3) throw new Error('MACD指标需要3个参数');
                indicators.macd = calculateMACD(closes, params[0], params[1], params[2]);
                break;
              case 'rsi':
                if (params.length !== 1) throw new Error('RSI指标需要1个参数');
                indicators.rsi = calculateRSI(closes, params[0]);
                break;
              case 'kdj':
                if (params.length !== 3) throw new Error('KDJ指标需要3个参数');
                indicators.kdj = calculateKDJ(highs, lows, closes, params[0], params[1], params[2]);
                break;
              case 'boll':
                if (params.length !== 2) throw new Error('布林带指标需要2个参数');
                indicators.boll = calculateBOLL(closes, params[0], params[1]);
                break;
              case 'ma':
                if (params.length !== 1) throw new Error('移动平均线需要1个参数');
                indicators[`ma${params[0]}`] = calculateSMA(closes, params[0]);
                break;
              default:
                throw new Error(`不支持的技术指标: ${name}`);
            }
          }
          Object.keys(indicators).forEach(key => {
            if (Array.isArray(indicators[key])) {
              indicators[key] = indicators[key].reverse();
            } else if (indicators[key] && typeof indicators[key] === 'object') {
              Object.keys(indicators[key]).forEach(subKey => {
                if (Array.isArray(indicators[key][subKey])) {
                  indicators[key][subKey] = indicators[key][subKey].reverse();
                }
              });
            }
          });
          rows = filterRowsAndIndicators(rows, indicators, userStartDate, userEndDate);
        }

        const fieldNameMap: Record<string, string> = {
          trade_date: '交易日期', open: '开盘', close: '收盘', high: '最高', low: '最低', vol: '成交量',
        };
        let formattedData = '';
        let indicatorData = '';
        if (rows.length > 0) {
          const coreFields = ['trade_date', 'open', 'close', 'high', 'low', 'vol'];
          const displayFields = coreFields.filter(field => field in rows[0]);
          const indicatorHeaders: string[] = [];
          const hasIndicators = Object.keys(indicators).length > 0;
          if (hasIndicators) {
            if (indicators.macd) indicatorHeaders.push('MACD_DIF', 'MACD_DEA', 'MACD');
            if (indicators.rsi) indicatorHeaders.push('RSI');
            if (indicators.kdj) indicatorHeaders.push('KDJ_K', 'KDJ_D', 'KDJ_J');
            if (indicators.boll) indicatorHeaders.push('BOLL_UP', 'BOLL_MID', 'BOLL_LOW');
            Object.keys(indicators).filter(k => k.startsWith('ma') && k !== 'macd').forEach(ma => indicatorHeaders.push(ma.toUpperCase()));
          }
          const allHeaders = [...displayFields.map(f => fieldNameMap[f] || f), ...indicatorHeaders];
          formattedData = `| ${allHeaders.join(' | ')} |\n|${allHeaders.map(() => '--------').join('|')}|\n`;
          rows.forEach((data: Record<string, any>, index: number) => {
            const basicRow = displayFields.map(field => data[field] ?? 'N/A');
            const indicatorRow: string[] = [];
            if (hasIndicators) {
              if (indicators.macd) {
                indicatorRow.push(
                  isNaN(indicators.macd.dif[index]) ? 'N/A' : indicators.macd.dif[index].toFixed(4),
                  isNaN(indicators.macd.dea[index]) ? 'N/A' : indicators.macd.dea[index].toFixed(4),
                  isNaN(indicators.macd.macd[index]) ? 'N/A' : indicators.macd.macd[index].toFixed(4),
                );
              }
              if (indicators.rsi) indicatorRow.push(isNaN(indicators.rsi[index]) ? 'N/A' : indicators.rsi[index].toFixed(2));
              if (indicators.kdj) {
                indicatorRow.push(
                  isNaN(indicators.kdj.k[index]) ? 'N/A' : indicators.kdj.k[index].toFixed(2),
                  isNaN(indicators.kdj.d[index]) ? 'N/A' : indicators.kdj.d[index].toFixed(2),
                  isNaN(indicators.kdj.j[index]) ? 'N/A' : indicators.kdj.j[index].toFixed(2),
                );
              }
              if (indicators.boll) {
                indicatorRow.push(
                  isNaN(indicators.boll.upper[index]) ? 'N/A' : indicators.boll.upper[index].toFixed(2),
                  isNaN(indicators.boll.middle[index]) ? 'N/A' : indicators.boll.middle[index].toFixed(2),
                  isNaN(indicators.boll.lower[index]) ? 'N/A' : indicators.boll.lower[index].toFixed(2),
                );
              }
              Object.keys(indicators).filter(k => k.startsWith('ma') && k !== 'macd').forEach(ma => {
                indicatorRow.push(isNaN(indicators[ma][index]) ? 'N/A' : indicators[ma][index].toFixed(2));
              });
            }
            formattedData += `| ${[...basicRow, ...indicatorRow].join(' | ')} |\n`;
          });
        }
        if (Object.keys(indicators).length > 0) {
          indicatorData = '\n\n## 📊 技术指标说明\n';
          const indicatorParams: Record<string, string> = {};
          for (const indicator of requestedIndicators) {
            try {
              const { name, params } = parseIndicatorParams(indicator);
              indicatorParams[name] = formatIndicatorParams(name, params);
            } catch {}
          }
          if (indicators.macd) indicatorData += `- **MACD${indicatorParams.macd || '(参数未知)'}**: DIF(快线)、DEA(慢线)、MACD(柱状图)\n`;
          if (indicators.rsi) indicatorData += `- **RSI${indicatorParams.rsi || '(参数未知)'}**: 相对强弱指标，范围0-100\n`;
          if (indicators.kdj) indicatorData += `- **KDJ${indicatorParams.kdj || '(参数未知)'}**: 随机指标，K线、D线、J线\n`;
          if (indicators.boll) indicatorData += `- **BOLL${indicatorParams.boll || '(参数未知)'}**: 布林带，上轨、中轨、下轨\n`;
          Object.keys(indicators).filter(k => k.startsWith('ma') && k !== 'macd').forEach(ma => {
            indicatorData += `- **${ma.toUpperCase()}(${ma.replace('ma', '')})**: 移动平均线\n`;
          });
        }
        return {
          content: [{ type: 'text', text: `# ${args.code} 加密货币行情数据\n\n${formattedData}${indicatorData}` }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: `# ${args.code} (${marketType}) 行情数据不可用\n\n未配置 QVERIS_API_KEY。原 Tushare 原生路径已移除，非加密货币市场请配置 QVERIS_API_KEY 后经由 Qveris 路由调用。`,
        }],
        isError: true,
      };
    } catch (error) {
      const message = error instanceof InvalidToolInputError
        ? '输入参数无效，请按支持格式提交股票代码和市场类型。'
        : '暂时无法获取数据，请稍后重试并检查参数。';
      return {
        content: [{ type: 'text', text: `# 获取股票数据失败\n\n${message}` }],
        isError: true,
      };
    }
  },
};
