import {
  ETF_CANDIDATE_DECLARATIONS,
  V3_SUPER_ETF_DEFENSIVE_BUCKET,
  V3_SUPER_ETF_GROWTH_BUCKET,
  V3_SUPER_ETF_SECTOR_PIONEER_CODES,
  V3_SUPER_ETF_VALUE_BUCKET,
} from '../ashare/etfDeclarations.js';
import { isEtfCode } from './ledger.js';

export type PortfolioSleeve =
  | 'STOCK_BP1'
  | 'SECTOR_PIONEER'
  | 'CHASSIS_LOWVOL'
  | 'CHASSIS_GOLD'
  | 'CHASSIS_VALUE'
  | 'CHASSIS_GROWTH'
  | 'BOND_RESERVOIR'
  | 'CASH_MMF'
  | 'UNMANAGED_LEGACY';

export const CASH_MMF_CODES: ReadonlySet<string> = new Set([
  '511990.SH',
  '511880.SH',
  '511660.SH',
]);

export const DEFAULT_BOND_RESERVOIR_CODES: ReadonlySet<string> = new Set(
  ETF_CANDIDATE_DECLARATIONS.filter(d => d.category === 'bond').map(d => d.ts_code),
);

const LOWVOL_SET: ReadonlySet<string> = new Set(V3_SUPER_ETF_DEFENSIVE_BUCKET);
const DEFAULT_GOLD_SET: ReadonlySet<string> = new Set(['518880.SH']);
const VALUE_SET: ReadonlySet<string> = new Set(V3_SUPER_ETF_VALUE_BUCKET);
const GROWTH_SET: ReadonlySet<string> = new Set(V3_SUPER_ETF_GROWTH_BUCKET);
const SECTOR_PIONEER_POOL_SET: ReadonlySet<string> = new Set(V3_SUPER_ETF_SECTOR_PIONEER_CODES);

export interface ClassifySleeveContext {
  /** Active target sector pioneer ETF codes for the current cycle. */
  activeSectorPioneerCodes?: ReadonlySet<string>;
  /** Configured bond reservoir codes (e.g. from policy + defaults). */
  bondCodes?: ReadonlySet<string>;
  /** Configured gold core ETF codes (e.g. 518880.SH in CORE_40). */
  goldCodes?: ReadonlySet<string>;
  /**
   * When true, any ETF in V3_SUPER_ETF_SECTOR_PIONEER_CODES is classified as
   * SECTOR_PIONEER for P1 tracking purposes even if rotated off target.
   */
  includeInactiveSectorPoolAsPioneer?: boolean;
}

/**
 * Explicitly classify a security code into its portfolio sleeve.
 * Never infers chassis vs pioneer solely from `isEtfCode()`.
 */
export function classifyHoldingSleeve(
  tsCode: string,
  ctx: ClassifySleeveContext = {},
): PortfolioSleeve {
  if (!isEtfCode(tsCode)) return 'STOCK_BP1';
  if (CASH_MMF_CODES.has(tsCode)) return 'CASH_MMF';
  if (ctx.bondCodes?.has(tsCode) || DEFAULT_BOND_RESERVOIR_CODES.has(tsCode)) {
    return 'BOND_RESERVOIR';
  }
  if (ctx.goldCodes?.has(tsCode) || DEFAULT_GOLD_SET.has(tsCode)) return 'CHASSIS_GOLD';
  if (LOWVOL_SET.has(tsCode)) return 'CHASSIS_LOWVOL';
  if (VALUE_SET.has(tsCode)) return 'CHASSIS_VALUE';
  if (GROWTH_SET.has(tsCode)) return 'CHASSIS_GROWTH';
  if (ctx.activeSectorPioneerCodes?.has(tsCode)) return 'SECTOR_PIONEER';
  if (ctx.includeInactiveSectorPoolAsPioneer && SECTOR_PIONEER_POOL_SET.has(tsCode)) {
    return 'SECTOR_PIONEER';
  }
  return 'UNMANAGED_LEGACY';
}

/** Risk equity sleeves subject to drawdown caps and equity target alignment. */
export function isRiskEquitySleeve(sleeve: PortfolioSleeve): boolean {
  return sleeve !== 'BOND_RESERVOIR' && sleeve !== 'CASH_MMF';
}
