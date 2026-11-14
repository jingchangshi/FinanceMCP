import test from 'node:test';
import assert from 'node:assert/strict';
import { IPS_V1, proposeRebalance, commissionCents } from '../build/portfolio/ips.js';

// 2026-11-10 持仓的示意数据（159558 价格/份额取自日报；其余价格为示意，仅用于验证规则）。
const SUPER = { commission_rate: 0.00005, commission_min_cents: 0 };
const NORMAL = { commission_rate: 0.00025, commission_min_cents: 500 };
const positions = [
  { code: '159558.SZ', asset_class: 'satellite', shares: 58900, sellable_shares: 58900, price_milli: 812, ...SUPER },
  { code: '560390.SH', asset_class: 'satellite', shares: 10000, sellable_shares: 10000, price_milli: 1084, ...SUPER },
  { code: '516080.SH', asset_class: 'satellite', shares: 8000, sellable_shares: 8000, price_milli: 830, ...NORMAL },
  { code: '159241.SZ', asset_class: 'satellite', shares: 1000, sellable_shares: 1000, price_milli: 989, ...NORMAL },
  { code: '159278.SZ', asset_class: 'satellite', shares: 1000, sellable_shares: 1000, price_milli: 980, ...NORMAL },
];
const candidates = [
  { code: '512890.SH', asset_class: 'equity_core', price_milli: 1230, ...NORMAL },
  { code: '511360.SH', asset_class: 'bond', price_milli: 114148, ...NORMAL },
  { code: '518880.SH', asset_class: 'gold', price_milli: 8289, ...NORMAL },
  { code: '513100.SH', asset_class: 'overseas', price_milli: 2233, premium_bps: 1959, ...NORMAL },
];
const base = { ips: IPS_V1, cash_cents: 154447, positions, buy_candidates: candidates };

test('commission floors at the 5-yuan minimum, none for floor-free codes', () => {
  assert.equal(commissionCents(1_000_000, 0.00025, 500), 500);
  assert.equal(commissionCents(4_000_000, 0.00005, 0), 200);
  assert.equal(commissionCents(0, 0.00025, 500), 0);
});

test('below L2 the concentrated position is held, not sold (user decision)', () => {
  const p = proposeRebalance({ ...base, drawdown_bps: 917 });
  assert.equal(p.orders.filter(o => o.side === 'SELL').length, 0);
  assert.match(p.notes.join(' '), /继续持有/);
  assert.equal(p.drift.find(d => d.asset_class === 'satellite').status, 'CAP_BREACH');
});

test('L2 trigger proposes a lot-rounded, bounded satellite reduction', () => {
  const p = proposeRebalance({ ...base, drawdown_bps: 1520 });
  const sells = p.orders.filter(o => o.side === 'SELL');
  assert.ok(sells.length >= 1);
  for (const o of sells) assert.equal(o.shares % 100, 0);
  const satValue = positions.reduce((a, x) => a + Math.round(x.shares * x.price_milli / 10), 0);
  const sold = sells.reduce((a, o) => a + o.est_amount_cents, 0);
  assert.ok(sold <= satValue * 0.5, 'never more than half of the satellite in one step');
  assert.ok(sold >= satValue * 0.2, 'meaningfully reduces risk');
});

test('overseas QDII is never bought at a high premium', () => {
  const p = proposeRebalance({ ...base, drawdown_bps: 1520 });
  assert.ok(!p.orders.some(o => o.code === '513100.SH'));
  assert.match(p.notes.join(' '), /溢价/);
});

test('T+1: unsellable shares produce no order', () => {
  const locked = positions.map(x => ({ ...x, sellable_shares: 0 }));
  const p = proposeRebalance({ ...base, positions: locked, drawdown_bps: 1520 });
  assert.equal(p.orders.filter(o => o.side === 'SELL').length, 0);
});

test('buys only use cash above the cash target and whole lots', () => {
  const p = proposeRebalance({ ...base, drawdown_bps: 1520 });
  for (const o of p.orders.filter(x => x.side === 'BUY')) assert.equal(o.shares % 100, 0);
  const spent = p.orders.filter(o => o.side === 'BUY').reduce((a, o) => a + o.est_amount_cents + o.est_commission_cents, 0);
  const sellNet = p.orders.filter(o => o.side === 'SELL').reduce((a, o) => a + o.est_amount_cents - o.est_commission_cents, 0);
  assert.ok(spent <= 154447 + sellNet);
});

test('no dust orders: remaining reduction below half a lot is skipped', () => {
  const p = proposeRebalance({ ...base, drawdown_bps: 1520 });
  for (const o of p.orders.filter(x => x.side === 'SELL')) assert.ok(o.est_amount_cents >= 5000, `dust order ${o.code}`);
});
