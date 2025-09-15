import { TUSHARE_CONFIG } from '../config.js';
/**
 * 分钟K线数据工具（A股）
 * 说明：调用 Tushare 分钟线接口，按指定时间范围与频率返回明细K线。
 */
export const stockDataMinutes = {
    name: 'stock_data_minutes',
    description: '获取A股分钟K线数据，支持1MIN/5MIN/15MIN/30MIN/60MIN，时间范围需提供起止日期时间',
    parameters: {
        type: 'object',
        properties: {
            code: {
                type: 'string',
                description: "股票代码，如 '600519.SH' 或 '000001.SZ'"
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
        required: ['code', 'start_datetime', 'end_datetime', 'freq']
    },
    async run(args) {
        try {
            const TUSHARE_API_KEY = TUSHARE_CONFIG.API_TOKEN;
            const TUSHARE_API_URL = TUSHARE_CONFIG.API_URL;
            if (!TUSHARE_API_KEY) {
                throw new Error('缺少 Tushare Token：请在请求头 X-Tushare-Token 或环境变量 TUSHARE_TOKEN 中提供');
            }
            // 归一化时间：转为 YYYYMMDDHHmmss（剔除非数字）
            const normalizeDT = (v) => v.replace(/[^0-9]/g, '').padEnd(14, '0').slice(0, 14);
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
            const freqMap = {
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
            // 组装请求（Tushare 分钟线：stk_mins）
            const requestBody = {
                api_name: 'stk_mins',
                token: TUSHARE_API_KEY,
                params: {
                    ts_code: args.code,
                    start_time: startTime,
                    end_time: endTime,
                    freq: freq
                }
                // 不指定 fields，默认返回全部
            };
            // 超时控制
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), TUSHARE_CONFIG.TIMEOUT);
            try {
                const resp = await fetch(TUSHARE_API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(requestBody),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                if (!resp.ok) {
                    throw new Error(`Tushare HTTP ${resp.status}`);
                }
                const data = await resp.json();
                if (data.code !== 0) {
                    throw new Error(`Tushare API错误: ${data.msg || 'unknown error'}`);
                }
                const fields = data.data?.fields || [];
                const items = data.data?.items || [];
                if (!fields.length || !items.length) {
                    return {
                        content: [{
                                type: 'text',
                                text: `# ${args.code} 分钟K线(${args.freq})\n\n区间: ${startTime} - ${endTime}\n\n暂无数据。`
                            }]
                    };
                }
                // 转对象数组
                const rows = items.map(row => {
                    const obj = {};
                    fields.forEach((f, i) => (obj[f] = row[i]));
                    return obj;
                });
                // 常见字段名兼容：trade_time/time/datetime
                const timeKey = ['trade_time', 'time', 'datetime'].find(k => fields.includes(k)) || 'trade_time';
                const openKey = ['open'].find(k => fields.includes(k)) || 'open';
                const highKey = ['high'].find(k => fields.includes(k)) || 'high';
                const lowKey = ['low'].find(k => fields.includes(k)) || 'low';
                const closeKey = ['close'].find(k => fields.includes(k)) || 'close';
                const volKey = ['vol', 'volume'].find(k => fields.includes(k)) || 'vol';
                const amountKey = ['amount', 'amt'].find(k => fields.includes(k)) || 'amount';
                // 按时间倒序（最新在上）
                rows.sort((a, b) => String(b[timeKey] || '').localeCompare(String(a[timeKey] || '')));
                // 构造表格
                let out = `# ${args.code} 分钟K线（${freq}）\n\n`;
                out += `查询区间: ${startTime} - ${endTime}\n`;
                out += `返回条数: ${rows.length}\n\n`;
                const headers = ['时间', '开盘', '最高', '最低', '收盘', '成交量', '成交额(万元)'];
                out += `| ${headers.join(' | ')} |\n`;
                out += `|${headers.map(() => '--------').join('|')}|\n`;
                for (const r of rows) {
                    const t = r[timeKey] ?? 'N/A';
                    const o = safeNum(r[openKey]);
                    const h = safeNum(r[highKey]);
                    const l = safeNum(r[lowKey]);
                    const c = safeNum(r[closeKey]);
                    const v = r[volKey] == null ? 'N/A' : String(r[volKey]);
                    const amt = r[amountKey] == null ? 'N/A' : String(r[amountKey]);
                    out += `| ${t} | ${fmt(o)} | ${fmt(h)} | ${fmt(l)} | ${fmt(c)} | ${v} | ${amt} |\n`;
                }
                return { content: [{ type: 'text', text: out }] };
            }
            finally {
                // 兜底清理
                // clearTimeout 在 try 内处理；此处确保未走到前面时也释放
            }
        }
        catch (err) {
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
function safeNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function fmt(n, d = 2) {
    return n == null ? 'N/A' : n.toFixed(d);
}
