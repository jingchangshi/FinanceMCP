import net from 'node:net';
import { inflateSync } from 'node:zlib';

export interface TdxHost {
  host: string;
  port: number;
}

export const DEFAULT_TDX_HOSTS: readonly TdxHost[] = [
  { host: '180.153.18.170', port: 7709 },
  { host: '115.238.56.198', port: 7709 },
  { host: '180.153.18.171', port: 7709 },
  { host: '180.153.39.51', port: 7709 },
  { host: '114.80.63.12', port: 7709 },
  { host: '114.80.63.35', port: 7709 },
  { host: '60.12.136.250', port: 7709 },
];

export function configuredTdxHosts(): TdxHost[] {
  const raw = process.env.ASHARE_TDX_HOSTS?.trim();
  if (!raw) return [...DEFAULT_TDX_HOSTS];
  const parsed: TdxHost[] = [];
  for (const entry of raw.split(',')) {
    const s = entry.trim();
    if (!s) continue;
    const [host, portStr] = s.split(':');
    const port = Number(portStr || '7709');
    if (host && Number.isInteger(port) && port > 0 && port < 65536) {
      parsed.push({ host: host.trim(), port });
    }
  }
  return parsed.length ? parsed : [...DEFAULT_TDX_HOSTS];
}

const gbkDecoder = new TextDecoder('gbk');

const HELLO1 = Buffer.from('0c0218930001030003000d0001', 'hex');
const HELLO2 = Buffer.from('0c0218940001030003000d0002', 'hex');

// ---------------------------------------------------------------- pure binary decoders

export function decodeTdxVarint(buf: Buffer, startPos: number): [number, number] {
  let pos = startPos;
  let byte = buf[pos];
  const sign = (byte & 0x40) !== 0;
  let intdata = byte & 0x3f;
  let shift = 6;
  while ((byte & 0x80) !== 0) {
    pos += 1;
    byte = buf[pos];
    intdata += (byte & 0x7f) * (2 ** shift);
    shift += 7;
  }
  pos += 1;
  return [sign ? -intdata : intdata, pos];
}

export function decodeTdxVolume(ivol: number): number {
  const u = ivol >>> 0;
  if (u === 0) return 0;
  const logpoint = (u >>> 24) & 0xff;
  const hleax = (u >>> 16) & 0xff;
  const lheax = (u >>> 8) & 0xff;
  const lleax = u & 0xff;

  const dwEcx = logpoint * 2 - 0x7f;
  const dwEdx = logpoint * 2 - 0x86;
  const dwEsi = logpoint * 2 - 0x8e;
  const dwEax = logpoint * 2 - 0x96;

  const dblXmm6 = 2 ** dwEcx;
  let dblXmm4: number;
  if (hleax > 0x80) {
    dblXmm4 = (2 ** dwEdx) * 128 + (hleax & 0x7f) * (2 ** (dwEdx + 1));
  } else {
    dblXmm4 = (2 ** dwEdx) * hleax;
  }
  let dblXmm3 = (2 ** dwEsi) * lheax;
  let dblXmm1 = (2 ** dwEax) * lleax;
  if ((hleax & 0x80) !== 0) {
    dblXmm3 *= 2;
    dblXmm1 *= 2;
  }
  return dblXmm6 + dblXmm4 + dblXmm3 + dblXmm1;
}

export function decodeTdxDateTime(
  category: number,
  buf: Buffer,
  startPos: number,
): { year: number; month: number; day: number; hour: number; minute: number; dateYmd: string; pos: number } {
  let year: number;
  let month: number;
  let day: number;
  let hour = 15;
  let minute = 0;
  let pos = startPos;

  if (category < 4 || category === 7 || category === 8) {
    const zipday = buf.readUInt16LE(pos);
    const tminutes = buf.readUInt16LE(pos + 2);
    pos += 4;
    year = (zipday >> 11) + 2004;
    month = Math.floor((zipday % 2048) / 100);
    day = (zipday % 2048) % 100;
    hour = Math.floor(tminutes / 60);
    minute = tminutes % 60;
  } else {
    const zipday = buf.readUInt32LE(pos);
    pos += 4;
    year = Math.floor(zipday / 10000);
    month = Math.floor((zipday % 10000) / 100);
    day = zipday % 100;
  }

  const dateYmd = `${String(year).padStart(4, '0')}${String(month).padStart(2, '0')}${String(day).padStart(2, '0')}`;
  return { year, month, day, hour, minute, dateYmd, pos };
}

export interface TdxSecurityItem {
  market: 0 | 1;
  code: string;
  volunit: number;
  decimalPoint: number;
  name: string;
  preClose: number;
}

export function parseSecurityListPayload(buf: Buffer, market: 0 | 1): TdxSecurityItem[] {
  if (buf.length < 2) return [];
  const num = buf.readUInt16LE(0);
  const items: TdxSecurityItem[] = [];
  let pos = 2;
  for (let i = 0; i < num && pos + 29 <= buf.length; i++) {
    const code = buf.subarray(pos, pos + 6).toString('ascii');
    const volunit = buf.readUInt16LE(pos + 6);
    const nameRaw = buf.subarray(pos + 8, pos + 16);
    const name = gbkDecoder.decode(nameRaw).replace(/\0.*$/s, '').trim();
    const decimalPoint = buf.readUInt8(pos + 20);
    const preCloseRaw = buf.readUInt32LE(pos + 21);
    const preClose = decodeTdxVolume(preCloseRaw);
    pos += 29;
    items.push({ market, code, volunit, decimalPoint, name, preClose });
  }
  return items;
}

export interface TdxBar {
  trade_date: string;
  hour: number;
  minute: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 手（股票/ETF/指数统一换算为手） */
  vol: number;
  /** 千元 */
  amount: number;
}

export function parseBarsPayload(buf: Buffer, category: number, isIndex: boolean): TdxBar[] {
  if (buf.length < 2) return [];
  const count = buf.readUInt16LE(0);
  let pos = 2;
  let preDiffBase = 0;
  const bars: TdxBar[] = [];

  for (let i = 0; i < count && pos + 12 <= buf.length; i++) {
    const dt = decodeTdxDateTime(category, buf, pos);
    pos = dt.pos;
    let openDiff: number;
    let closeDiff: number;
    let highDiff: number;
    let lowDiff: number;
    [openDiff, pos] = decodeTdxVarint(buf, pos);
    [closeDiff, pos] = decodeTdxVarint(buf, pos);
    [highDiff, pos] = decodeTdxVarint(buf, pos);
    [lowDiff, pos] = decodeTdxVarint(buf, pos);
    const volRaw = buf.readUInt32LE(pos);
    const amountRaw = buf.readUInt32LE(pos + 4);
    pos += 8;
    if (isIndex) pos += 4;

    const openBase = openDiff + preDiffBase;
    const closeBase = openBase + closeDiff;
    const highBase = openBase + highDiff;
    const lowBase = openBase + lowDiff;
    preDiffBase = closeBase;

    const rawVol = decodeTdxVolume(volRaw);
    const amountYuan = decodeTdxVolume(amountRaw);
    bars.push({
      trade_date: dt.dateYmd,
      hour: dt.hour,
      minute: dt.minute,
      open: openBase / 1000,
      high: highBase / 1000,
      low: lowBase / 1000,
      close: closeBase / 1000,
      vol: isIndex ? rawVol * 100 : rawVol,
      amount: amountYuan / 1000,
    });
  }
  return bars;
}

export interface TdxQuote {
  market: number;
  code: string;
  close: number;
  pre_close: number;
  open: number;
  high: number;
  low: number;
  vol: number;
  amount: number;
}

export function parseSecurityQuotesPayload(
  buf: Buffer,
  decimalResolver: (market: number, code: string) => number,
): TdxQuote[] {
  if (buf.length < 4) return [];
  let pos = 2;
  const count = buf.readUInt16LE(pos);
  pos += 2;
  const quotes: TdxQuote[] = [];

  for (let i = 0; i < count && pos + 9 <= buf.length; i++) {
    const market = buf.readUInt8(pos);
    const code = buf.subarray(pos + 1, pos + 7).toString('ascii');
    pos += 9; // market(1) + code(6) + active1(2)

    let priceRaw: number;
    let lastCloseDiff: number;
    let openDiff: number;
    let highDiff: number;
    let lowDiff: number;
    let vol: number;
    [priceRaw, pos] = decodeTdxVarint(buf, pos);
    [lastCloseDiff, pos] = decodeTdxVarint(buf, pos);
    [openDiff, pos] = decodeTdxVarint(buf, pos);
    [highDiff, pos] = decodeTdxVarint(buf, pos);
    [lowDiff, pos] = decodeTdxVarint(buf, pos);
    [, pos] = decodeTdxVarint(buf, pos); // servertime / rev0
    [, pos] = decodeTdxVarint(buf, pos); // rev1
    [vol, pos] = decodeTdxVarint(buf, pos);
    [, pos] = decodeTdxVarint(buf, pos); // curVol
    const amountRaw = buf.readUInt32LE(pos);
    pos += 4;
    [, pos] = decodeTdxVarint(buf, pos); // s_vol
    [, pos] = decodeTdxVarint(buf, pos); // b_vol
    [, pos] = decodeTdxVarint(buf, pos); // rev2
    [, pos] = decodeTdxVarint(buf, pos); // rev3
    for (let b = 0; b < 20; b++) {
      [, pos] = decodeTdxVarint(buf, pos);
    }
    pos += 2; // rev4 uint16
    for (let k = 0; k < 4; k++) {
      [, pos] = decodeTdxVarint(buf, pos);
    }
    pos += 4; // rev9(2) + active2(2)

    const scale = 10 ** decimalResolver(market, code);
    quotes.push({
      market,
      code,
      close: priceRaw / scale,
      pre_close: (priceRaw + lastCloseDiff) / scale,
      open: (priceRaw + openDiff) / scale,
      high: (priceRaw + highDiff) / scale,
      low: (priceRaw + lowDiff) / scale,
      vol,
      amount: decodeTdxVolume(amountRaw) / 1000,
    });
  }
  return quotes;
}

export interface TdxXdxrEvent {
  date: string;
  category: number;
  fenhong: number | null;
  peigujia: number | null;
  songzhuangu: number | null;
  peigu: number | null;
  suogu: number | null;
}

export function parseXdxrPayload(buf: Buffer): TdxXdxrEvent[] {
  if (buf.length < 11) return [];
  const count = buf.readUInt16LE(9);
  let pos = 11;
  const rows: TdxXdxrEvent[] = [];
  for (let i = 0; i < count && pos + 29 <= buf.length; i++) {
    pos += 8; // market(1) + code(6) + reserved(1)
    const dt = decodeTdxDateTime(9, buf, pos);
    pos = dt.pos;
    const category = buf.readUInt8(pos);
    pos += 1;
    let fenhong: number | null = null;
    let peigujia: number | null = null;
    let songzhuangu: number | null = null;
    let peigu: number | null = null;
    let suogu: number | null = null;
    if (category === 1) {
      fenhong = buf.readFloatLE(pos);
      peigujia = buf.readFloatLE(pos + 4);
      songzhuangu = buf.readFloatLE(pos + 8);
      peigu = buf.readFloatLE(pos + 12);
    } else if (category === 11 || category === 12) {
      suogu = buf.readFloatLE(pos + 8);
    }
    pos += 16;
    rows.push({ date: dt.dateYmd, category, fenhong, peigujia, songzhuangu, peigu, suogu });
  }
  return rows;
}

// ---------------------------------------------------------------- framed TCP session

export class TdxSession {
  private socket: net.Socket | null = null;
  private recvBuf = Buffer.alloc(0);
  private waiters: Array<{ need: number; resolve: (buf: Buffer) => void; reject: (err: Error) => void }> = [];
  private closedErr: Error | null = null;
  private lock: Promise<unknown> = Promise.resolve();

  constructor(private readonly target: TdxHost, private readonly timeoutMs = 4500) {}

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.target.host, port: this.target.port });
      const timer = setTimeout(() => {
        sock.destroy(new Error(`TDX connect timeout ${this.target.host}:${this.target.port}`));
      }, this.timeoutMs);

      const onErr = (err: Error) => {
        clearTimeout(timer);
        this.failWaiters(err);
        reject(err);
      };
      sock.once('error', onErr);
      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeListener('error', onErr);
        sock.on('data', (chunk: Buffer) => {
          this.recvBuf = this.recvBuf.length ? Buffer.concat([this.recvBuf, chunk]) : chunk;
          this.drainWaiters();
        });
        sock.on('error', err => this.failWaiters(err));
        sock.on('close', () => this.failWaiters(new Error(`TDX socket closed (${this.target.host}:${this.target.port})`)));
        this.socket = sock;
        resolve();
      });
    });

    await this.request(HELLO1);
    await this.request(HELLO2);
  }

  close(): void {
    try {
      this.socket?.destroy();
    } catch { /* ignore */ }
    this.socket = null;
  }

  private failWaiters(err: Error): void {
    if (this.closedErr) return;
    this.closedErr = err;
    while (this.waiters.length) {
      this.waiters.shift()!.reject(err);
    }
  }

  private drainWaiters(): void {
    while (this.waiters.length && this.recvBuf.length >= this.waiters[0].need) {
      const w = this.waiters.shift()!;
      const slice = this.recvBuf.subarray(0, w.need);
      this.recvBuf = this.recvBuf.subarray(w.need);
      w.resolve(slice);
    }
  }

  private readExact(bytes: number): Promise<Buffer> {
    if (bytes === 0) return Promise.resolve(Buffer.alloc(0));
    if (this.recvBuf.length >= bytes) {
      const slice = this.recvBuf.subarray(0, bytes);
      this.recvBuf = this.recvBuf.subarray(bytes);
      return Promise.resolve(slice);
    }
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex(w => w.reject === rej);
        if (idx >= 0) this.waiters.splice(idx, 1);
        const err = new Error(`TDX read timeout (${this.target.host}:${this.target.port})`);
        // 超时后 recvBuf 里可能残留半个响应，继续复用会话会把旧字节当成下一次响应。
        // 直接作废整个会话：所有等待者失败，后续请求快速失败，由上层换主站/降级。
        this.failWaiters(err);
        this.close();
        reject(err);
      }, this.timeoutMs);
      const res = (buf: Buffer) => { clearTimeout(timer); resolve(buf); };
      const rej = (err: Error) => { clearTimeout(timer); reject(err); };
      this.waiters.push({ need: bytes, resolve: res, reject: rej });
    });
  }

  private request(pkt: Buffer): Promise<Buffer> {
    const run = this.lock.then(async () => {
      if (!this.socket || this.socket.destroyed) throw new Error('TDX not connected');
      await new Promise<void>((resolve, reject) => {
        this.socket!.write(pkt, err => (err ? reject(err) : resolve()));
      });
      const hdr = await this.readExact(16);
      const zipsize = hdr.readUInt16LE(12);
      const unzipsize = hdr.readUInt16LE(14);
      const body = await this.readExact(zipsize);
      return zipsize === unzipsize ? body : inflateSync(body);
    }).catch((err: Error) => {
      // 解析/写入/读取任一环节失败都视为流已不可信（响应边界无法再对齐），关闭会话。
      this.failWaiters(err instanceof Error ? err : new Error(String(err)));
      this.close();
      throw err;
    });
    this.lock = run.catch(() => undefined);
    return run;
  }

  async getSecurityCount(market: 0 | 1): Promise<number> {
    const pkt = Buffer.alloc(18);
    Buffer.from('0c0c186c0001080008004e04', 'hex').copy(pkt, 0);
    pkt.writeUInt16LE(market, 12);
    Buffer.from('75c73301', 'hex').copy(pkt, 14);
    const body = await this.request(pkt);
    return body.length >= 2 ? body.readUInt16LE(0) : 0;
  }

  async getSecurityList(market: 0 | 1, start = 0): Promise<TdxSecurityItem[]> {
    const pkt = Buffer.alloc(16);
    Buffer.from('0c0118640101060006005004', 'hex').copy(pkt, 0);
    pkt.writeUInt16LE(market, 12);
    pkt.writeUInt16LE(start, 14);
    const body = await this.request(pkt);
    return parseSecurityListPayload(body, market);
  }

  async getAllSecurities(market: 0 | 1): Promise<TdxSecurityItem[]> {
    const total = await this.getSecurityCount(market);
    const all: TdxSecurityItem[] = [];
    for (let start = 0; start < total; start += 1000) {
      const page = await this.getSecurityList(market, start);
      if (!page.length) break;
      all.push(...page);
      if (page.length < 1000) break;
    }
    return all;
  }

  async getBars(
    category: number,
    market: 0 | 1,
    code: string,
    start = 0,
    count = 800,
    isIndex = false,
  ): Promise<TdxBar[]> {
    const pkt = Buffer.alloc(38);
    pkt.writeUInt16LE(0x10c, 0);
    pkt.writeUInt32LE(0x01016408, 2);
    pkt.writeUInt16LE(0x1c, 6);
    pkt.writeUInt16LE(0x1c, 8);
    pkt.writeUInt16LE(0x052d, 10);
    pkt.writeUInt16LE(market, 12);
    Buffer.from(code.slice(0, 6).padEnd(6, '0'), 'ascii').copy(pkt, 14);
    pkt.writeUInt16LE(category, 20);
    pkt.writeUInt16LE(1, 22);
    pkt.writeUInt16LE(start, 24);
    pkt.writeUInt16LE(count, 26);
    // bytes 28..37 remain 0
    const body = await this.request(pkt);
    return parseBarsPayload(body, category, isIndex);
  }

  async getSecurityQuotes(
    items: ReadonlyArray<{ market: 0 | 1; code: string }>,
    decimalResolver: (market: number, code: string) => number,
  ): Promise<TdxQuote[]> {
    if (!items.length) return [];
    const len = items.length;
    const pktDataLen = len * 7 + 12;
    const pkt = Buffer.alloc(22 + len * 7);
    pkt.writeUInt16LE(0x10c, 0);
    pkt.writeUInt32LE(0x02006320, 2);
    pkt.writeUInt16LE(pktDataLen, 6);
    pkt.writeUInt16LE(pktDataLen, 8);
    pkt.writeUInt32LE(0x5053e, 10);
    pkt.writeUInt32LE(0, 14);
    pkt.writeUInt16LE(0, 18);
    pkt.writeUInt16LE(len, 20);
    let offset = 22;
    for (const item of items) {
      pkt.writeUInt8(item.market, offset);
      Buffer.from(item.code.slice(0, 6).padEnd(6, '0'), 'ascii').copy(pkt, offset + 1);
      offset += 7;
    }
    const body = await this.request(pkt);
    return parseSecurityQuotesPayload(body, decimalResolver);
  }

  async getXdxrInfo(market: 0 | 1, code: string): Promise<TdxXdxrEvent[]> {
    const pkt = Buffer.alloc(21);
    Buffer.from('0c1f187600010b000b000f000100', 'hex').copy(pkt, 0);
    pkt.writeUInt8(market, 14);
    Buffer.from(code.slice(0, 6).padEnd(6, '0'), 'ascii').copy(pkt, 15);
    const body = await this.request(pkt);
    return parseXdxrPayload(body);
  }
}

export async function withTdxSession<T>(
  fn: (session: TdxSession) => Promise<T>,
  hosts: readonly TdxHost[] = configuredTdxHosts(),
  timeoutMs = 4500,
): Promise<T> {
  const errors: string[] = [];
  for (const h of hosts) {
    const session = new TdxSession(h, timeoutMs);
    try {
      await session.connect();
      return await fn(session);
    } catch (err: any) {
      errors.push(`${h.host}:${h.port}: ${String(err?.message ?? err)}`);
    } finally {
      session.close();
    }
  }
  throw new Error(`TDX 全部行情主站连接或请求失败: ${errors.slice(0, 4).join('; ')}`);
}
