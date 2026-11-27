import {
  V3_SUPER_ETF_DEFENSIVE_BUCKET,
  V3_SUPER_ETF_GROWTH_BUCKET,
  V3_SUPER_ETF_VALUE_BUCKET,
} from '../ashare/etfDeclarations.js';
import type { EtfCandidateRow, EtfCandidateScreenResult } from '../ashare/etfUniverse.js';
import type { MarketRegimeResult, MarketRegimeTier, MarketStyleTier } from '../ashare/marketRegime.js';
import type { SectorPioneerCandidate } from '../ashare/sectorPioneer.js';
import { classifyHoldingSleeve, type PortfolioSleeve } from './sleeveClassifier.js';
import type { StrategyRouterResult } from './strategyRouter.js';
import type { ApprovedV3Policy } from './v3Policy.js';

export interface TargetHoldingInput {
  ts_code: string;
  name?: string;
  quantity: number;
  market_value_cents: number;
  price_milli: number;
  bar_quality: string;
}

export interface TargetSlot {
  ts_code: string;
  sleeve: PortfolioSleeve;
  target_bps: number;
  target_cents: number;
  drift_band_bps: number;
  buy_blocked: boolean;
}

export interface TargetPortfolioResult {
  slots: Map<string, TargetSlot>;
  bondCodes: Set<string>;
  primaryBondCode: string | null;
  activeSectorPioneerCodes: Set<string>;
  chassisTargetCodes: Set<string>;
  unmanagedLegacyCodes: Set<string>;
}

interface ChassisBucketSpec {
  sleeve: 'CHASSIS_LOWVOL' | 'CHASSIS_VALUE' | 'CHASSIS_GROWTH';
  codes: readonly string[];
  share_bps: number;
  max_slots: number;
}

function chassisBucketSpecs(
  regime: MarketRegimeTier,
  style: MarketStyleTier,
  lowVolShareBps: number,
  singlePerStyle: boolean,
): ChassisBucketSpec[] {
  if (regime === 'DEFENSIVE') {
    return [
      {
        sleeve: 'CHASSIS_LOWVOL',
        codes: V3_SUPER_ETF_DEFENSIVE_BUCKET,
        share_bps: 10000,
        max_slots: 2,
      },
    ];
  }
  if (lowVolShareBps > 0 && lowVolShareBps < 10000) {
    const rem = 10000 - lowVolShareBps;
    const growthShareBps = lowVolShareBps === 3000
      ? (style === 'GROWTH_LEADING' ? 4500 : style === 'VALUE_LEADING' ? 2500 : 3500)
      : Math.round(rem * (style === 'GROWTH_LEADING' ? 0.65 : style === 'VALUE_LEADING' ? 0.35 : 0.50));
    const valueShareBps = rem - growthShareBps;
    return [
      {
        sleeve: 'CHASSIS_LOWVOL',
        codes: V3_SUPER_ETF_DEFENSIVE_BUCKET,
        share_bps: lowVolShareBps,
        max_slots: 2,
      },
      {
        sleeve: 'CHASSIS_GROWTH',
        codes: singlePerStyle ? V3_SUPER_ETF_GROWTH_BUCKET : V3_SUPER_ETF_GROWTH_BUCKET.slice(0, 3),
        share_bps: growthShareBps,
        max_slots: singlePerStyle ? 1 : 3,
      },
      {
        sleeve: 'CHASSIS_VALUE',
        codes: V3_SUPER_ETF_VALUE_BUCKET,
        share_bps: valueShareBps,
        max_slots: singlePerStyle ? 1 : V3_SUPER_ETF_VALUE_BUCKET.length,
      },
    ];
  }
  const growthShareBps = style === 'GROWTH_LEADING' ? 6500 : style === 'VALUE_LEADING' ? 3500 : 5000;
  return [
    {
      sleeve: 'CHASSIS_GROWTH',
      codes: singlePerStyle ? V3_SUPER_ETF_GROWTH_BUCKET : V3_SUPER_ETF_GROWTH_BUCKET.slice(0, 3),
      share_bps: growthShareBps,
      max_slots: singlePerStyle ? 1 : 3,
    },
    {
      sleeve: 'CHASSIS_VALUE',
      codes: V3_SUPER_ETF_VALUE_BUCKET,
      share_bps: 10000 - growthShareBps,
      max_slots: singlePerStyle ? 1 : V3_SUPER_ETF_VALUE_BUCKET.length,
    },
  ];
}

function isCandidateBuyEligible(row: EtfCandidateRow | undefined): boolean {
  if (!row) return false;
  return Boolean(row.included && !row.data?.buy_blocked && (row.data?.latest_close_milli ?? 0) > 0);
}

/**
 * Select chassis bucket members strictly by declaration priority order (high -> low):
 * each bucket walks its priority list once and picks the first member(s) that are
 * either (a) already held and holdable (READY bar) OR (b) currently buy-eligible.
 *
 * This guarantees:
 * - Held higher-priority members stay sticky when temporarily buy-blocked (no churn);
 * - If a lower-priority backup was held before the primary listed, it upgrades ONCE
 *   to the higher-priority member once eligible and never oscillates back.
 */
function selectChassisBucketMembers(
  spec: ChassisBucketSpec,
  holdingsByCode: Map<string, TargetHoldingInput>,
  candidateByCode: Map<string, EtfCandidateRow>,
  singlePerStyle: boolean,
): string[] {
  if (!singlePerStyle && spec.sleeve !== 'CHASSIS_LOWVOL') {
    return spec.codes.filter(code => isCandidateBuyEligible(candidateByCode.get(code)));
  }

  const maxSlots = spec.max_slots;
  const selected: string[] = [];

  for (const code of spec.codes) {
    if (selected.length >= maxSlots) break;
    const h = holdingsByCode.get(code);
    const heldHoldable = Boolean(
      h
      && h.quantity > 0
      && h.bar_quality === 'READY'
      && h.price_milli > 0,
    );
    const buyEligible = isCandidateBuyEligible(candidateByCode.get(code));
    if (heldHoldable || buyEligible) {
      selected.push(code);
    }
  }

  return selected;
}

export interface BuildTargetPortfolioInput {
  policy: ApprovedV3Policy;
  router: StrategyRouterResult;
  marketRegime: MarketRegimeResult;
  investableAssetsCents: number;
  asOf: string;
  holdings: readonly TargetHoldingInput[];
  candidates?: EtfCandidateScreenResult | null;
  sectorPioneerCandidates?: readonly SectorPioneerCandidate[];
}

/**
 * Build declarative target portfolio `Map<ts_code, TargetSlot>` across the entire account.
 * Every non-target holding (including UNMANAGED_LEGACY, rotated-out ETFs, or unallocated stocks)
 * is explicitly recorded with `target_bps = 0` and `target_cents = 0`.
 */
export function buildTargetPortfolio(input: BuildTargetPortfolioInput): TargetPortfolioResult {
  const { policy, router, marketRegime, investableAssetsCents, asOf } = input;
  const slots = new Map<string, TargetSlot>();

  const holdingsByCode = new Map<string, TargetHoldingInput>();
  for (const h of input.holdings) {
    if (h.quantity > 0) holdingsByCode.set(h.ts_code, h);
  }

  const candidateByCode = new Map<string, EtfCandidateRow>();
  for (const row of input.candidates?.candidates ?? []) {
    candidateByCode.set(row.ts_code, row);
  }

  const bondCodes = new Set<string>();
  for (const raw of [
    policy.defensive_bond_reservoir_etf,
    policy.defensive_bond_reservoir_fallback_etf,
    policy.defensive_bond_reservoir_tertiary_etf,
    '511010.SH',
  ]) {
    if (raw) bondCodes.add(raw);
  }

  const activeSectorPioneerCodes = new Set<string>();
  const activeSectorPioneers = policy.sector_pioneer_enabled && router.targets.sector_pioneer_bps > 0
    ? (input.sectorPioneerCandidates ?? []).slice(0, Math.max(1, policy.sector_pioneer_top_k))
    : [];
  for (const cand of activeSectorPioneers) {
    activeSectorPioneerCodes.add(cand.ts_code);
  }

  const equityDriftBandBps = policy.equity_align_drift_band_bps;
  const bondDriftBandBps = policy.defensive_bond_reservoir_drift_band_bps;

  // 1) Sector Pioneer targets (if enabled)
  if (activeSectorPioneers.length > 0 && router.targets.sector_pioneer_bps > 0) {
    const perSlotCapBps = Math.min(2000, Math.floor(router.targets.sector_pioneer_bps / activeSectorPioneers.length));
    for (const cand of activeSectorPioneers) {
      const cRow = candidateByCode.get(cand.ts_code);
      const buyBlocked = Boolean(cRow && (!cRow.included || cRow.data?.buy_blocked));
      const heldVal = holdingsByCode.get(cand.ts_code)?.market_value_cents ?? 0;
      const rawTargetCents = Math.round(investableAssetsCents * (perSlotCapBps / 10000));
      const effCents = buyBlocked ? Math.min(rawTargetCents, heldVal) : rawTargetCents;
      const effBps = investableAssetsCents > 0 ? Math.round((effCents / investableAssetsCents) * 10000) : 0;
      slots.set(cand.ts_code, {
        ts_code: cand.ts_code,
        sleeve: 'SECTOR_PIONEER',
        target_bps: effBps,
        target_cents: effCents,
        drift_band_bps: equityDriftBandBps,
        buy_blocked: buyBlocked,
      });
    }
  }

  // 2) Chassis ETF buckets (unconditional 1+1+2 when chassis_single_etf_per_style_bucket=true)
  const chassisTargetCodes = new Set<string>();
  const targetBaseEtfBps = router.targets.base_super_etf_bps;
  if (targetBaseEtfBps > 0) {
    const specs = chassisBucketSpecs(
      router.effective_regime,
      marketRegime.style,
      policy.lowvol_core_permanent_share_bps,
      policy.chassis_single_etf_per_style_bucket,
    );
    for (const spec of specs) {
      const bucketTargetBps = (targetBaseEtfBps * spec.share_bps) / 10000;
      const bucketTargetCents = Math.round(investableAssetsCents * (bucketTargetBps / 10000));
      const picked = selectChassisBucketMembers(
        spec,
        holdingsByCode,
        candidateByCode,
        policy.chassis_single_etf_per_style_bucket,
      );
      if (picked.length === 0) continue;
      const perSlotBps = bucketTargetBps / picked.length;
      const perSlotCents = Math.floor(bucketTargetCents / picked.length);
      for (const code of picked) {
        chassisTargetCodes.add(code);
        const cRow = candidateByCode.get(code);
        const buyBlocked = Boolean(cRow && (!cRow.included || cRow.data?.buy_blocked));
        const heldVal = holdingsByCode.get(code)?.market_value_cents ?? 0;
        const effCents = buyBlocked ? Math.min(perSlotCents, heldVal) : perSlotCents;
        const effBps = buyBlocked
          ? (investableAssetsCents > 0 ? Math.round((effCents / investableAssetsCents) * 10000) : 0)
          : Math.round(perSlotBps);
        slots.set(code, {
          ts_code: code,
          sleeve: spec.sleeve,
          target_bps: effBps,
          target_cents: effCents,
          drift_band_bps: equityDriftBandBps,
          buy_blocked: buyBlocked,
        });
      }
    }
  }

  // 3) Bond reservoir primary target (L2_LOCKED keeps bond reservoir active)
  const orderedBonds: string[] = [];
  for (const raw of [
    policy.defensive_bond_reservoir_etf,
    policy.defensive_bond_reservoir_fallback_etf,
    policy.defensive_bond_reservoir_tertiary_etf,
    '511010.SH',
  ]) {
    if (raw && !orderedBonds.includes(raw)) orderedBonds.push(raw);
  }
  const primaryBondCode = orderedBonds.find(code => {
    const row = candidateByCode.get(code);
    return Boolean(
      row
      && row.data?.latest_bar_date === asOf
      && (row.data?.latest_close_milli ?? 0) > 0
      && row.included
      && !row.data?.buy_blocked,
    );
  }) ?? policy.defensive_bond_reservoir_etf;

  const cashBufferCents = 10_000;
  const targetDefensiveCents = Math.round(investableAssetsCents * (router.targets.defensive_cash_bps / 10000));
  const targetBondCents = Math.max(0, targetDefensiveCents - cashBufferCents);
  if (primaryBondCode) {
    const row = candidateByCode.get(primaryBondCode);
    const buyBlocked = Boolean(row && (!row.included || row.data?.buy_blocked));
    slots.set(primaryBondCode, {
      ts_code: primaryBondCode,
      sleeve: 'BOND_RESERVOIR',
      target_bps: investableAssetsCents > 0 ? Math.round((targetBondCents / investableAssetsCents) * 10000) : 0,
      target_cents: targetBondCents,
      drift_band_bps: bondDriftBandBps,
      buy_blocked: buyBlocked,
    });
  }

  // 4) Explicitly record every existing holding in the target map
  const unmanagedLegacyCodes = new Set<string>();
  const stockHoldings = input.holdings.filter(
    h => h.quantity > 0 && classifyHoldingSleeve(h.ts_code, { activeSectorPioneerCodes, bondCodes }) === 'STOCK_BP1',
  );
  let remainingStockBudgetCents = Math.round(investableAssetsCents * (router.targets.pioneer_bps / 10000));
  const maxStockSlotCents = Math.round(investableAssetsCents * (policy.stock_max_single_weight_bps / 10000));

  for (const h of stockHoldings) {
    if (router.targets.pioneer_bps <= 0 || remainingStockBudgetCents <= 0) {
      slots.set(h.ts_code, {
        ts_code: h.ts_code,
        sleeve: 'STOCK_BP1',
        target_bps: 0,
        target_cents: 0,
        drift_band_bps: equityDriftBandBps,
        buy_blocked: false,
      });
    } else {
      // Held BP1 stock keeps up to min(held, single stock cap, remaining pioneer budget)
      // so risk-budget-sized positions are not churned unless cap/regime cuts them.
      const keepCents = Math.min(h.market_value_cents, maxStockSlotCents, remainingStockBudgetCents);
      remainingStockBudgetCents = Math.max(0, remainingStockBudgetCents - keepCents);
      slots.set(h.ts_code, {
        ts_code: h.ts_code,
        sleeve: 'STOCK_BP1',
        target_bps: investableAssetsCents > 0 ? Math.round((keepCents / investableAssetsCents) * 10000) : 0,
        target_cents: keepCents,
        drift_band_bps: equityDriftBandBps,
        buy_blocked: false,
      });
    }
  }

  for (const h of input.holdings) {
    if (h.quantity <= 0 || slots.has(h.ts_code)) continue;
    const sleeve = classifyHoldingSleeve(h.ts_code, { activeSectorPioneerCodes, bondCodes });
    if (sleeve === 'UNMANAGED_LEGACY') unmanagedLegacyCodes.add(h.ts_code);
    slots.set(h.ts_code, {
      ts_code: h.ts_code,
      sleeve,
      target_bps: 0,
      target_cents: 0,
      drift_band_bps: sleeve === 'BOND_RESERVOIR' ? bondDriftBandBps : 0,
      buy_blocked: false,
    });
  }

  return {
    slots,
    bondCodes,
    primaryBondCode,
    activeSectorPioneerCodes,
    chassisTargetCodes,
    unmanagedLegacyCodes,
  };
}
