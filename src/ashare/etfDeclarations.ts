/**
 * 声明式 ETF 候选池（无依赖的纯数据模块）。
 *
 * 单独成文件的原因：`etf.ts` 需要知道候选池有哪些代码（复核权/份额与逐只日线
 * 兜底），而 `etfUniverse.ts` 又需要 `etf.ts` 的 `ETF_UNIVERSE` 与复权因子。
 * 把**声明**放进这个只含字面量的模块，两个方向都不会形成循环依赖。
 *
 * 这里的内容仍然是**声明**，不是上游事实：真实名称只取 `fund_basic.name`。
 */

/** R0 冻结的五只持仓 ETF（零依赖常量，避免循环导入）。 */
export const ETF_UNIVERSE = ['159241.SZ', '159278.SZ', '159558.SZ', '516080.SH', '560390.SH'] as const;

export type EtfCandidateCategory = 'broad_based' | 'industry_theme' | 'bond' | 'gold' | 'cross_border';

export const ETF_CANDIDATE_CATEGORIES: readonly EtfCandidateCategory[] = [
  'broad_based', 'industry_theme', 'bond', 'gold', 'cross_border',
];

export const ETF_CANDIDATE_CATEGORY_LABELS: Record<EtfCandidateCategory, string> = {
  broad_based: '宽基',
  industry_theme: '行业/主题',
  bond: '债券',
  gold: '黄金/贵金属',
  cross_border: '跨境',
};

export interface EtfCandidateDeclaration {
  ts_code: string;
  category: EtfCandidateCategory;
  /** 声明式名称提示。真实名称只用 `fund_basic.name`；缺失时标为 hint，不当事实。 */
  name_hint: string;
  /** 声明式基准指数提示，仅供人工复核。 */
  benchmark_hint: string | null;
  /** 可计算跟踪误差的指数代码；只有该指数在 `index_daily` 中缓存时才计算。 */
  benchmark_index_code: string | null;
}

/**
 * 声明式候选池（**不是**上游事实）。分类与名称由本文件声明，版本号随输出返回；
 * 改变名单必须同时改版本号，保证历史输出可复现。
 * 五只持仓在 `ETF_UNIVERSE` 中，这里重复声明只是因为分类需要，`held` 由持仓表决定。
 */
export const ETF_CANDIDATE_DECLARATIONS: readonly EtfCandidateDeclaration[] = [
  // 宽基
  { ts_code: '510300.SH', category: 'broad_based', name_hint: '沪深300ETF', benchmark_hint: '沪深300指数', benchmark_index_code: '000300.SH' },
  { ts_code: '510500.SH', category: 'broad_based', name_hint: '中证500ETF', benchmark_hint: '中证500指数', benchmark_index_code: '000905.SH' },
  { ts_code: '512100.SH', category: 'broad_based', name_hint: '中证1000ETF', benchmark_hint: '中证1000指数', benchmark_index_code: '000852.SH' },
  { ts_code: '588000.SH', category: 'broad_based', name_hint: '科创50ETF', benchmark_hint: '科创50指数', benchmark_index_code: '000688.SH' },
  // 行业/主题（含五只真实持仓）
  { ts_code: '159241.SZ', category: 'industry_theme', name_hint: '航空航天ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '159278.SZ', category: 'industry_theme', name_hint: '机器人ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '159558.SZ', category: 'industry_theme', name_hint: '半导体设备ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '516080.SH', category: 'industry_theme', name_hint: '创新药ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '560390.SH', category: 'industry_theme', name_hint: '电网设备ETF', benchmark_hint: null, benchmark_index_code: null },
  { ts_code: '512480.SH', category: 'industry_theme', name_hint: '半导体ETF', benchmark_hint: '中证全指半导体', benchmark_index_code: null },
  { ts_code: '512660.SH', category: 'industry_theme', name_hint: '军工ETF', benchmark_hint: '中证军工', benchmark_index_code: null },
  { ts_code: '512010.SH', category: 'industry_theme', name_hint: '医药ETF', benchmark_hint: '沪深300医药卫生', benchmark_index_code: null },
  { ts_code: '515790.SH', category: 'industry_theme', name_hint: '光伏ETF', benchmark_hint: '中证光伏产业', benchmark_index_code: null },
  // 债券
  { ts_code: '511010.SH', category: 'bond', name_hint: '国债ETF', benchmark_hint: '上证5年期国债', benchmark_index_code: null },
  { ts_code: '511260.SH', category: 'bond', name_hint: '十年国债ETF', benchmark_hint: '中债10年期国债', benchmark_index_code: null },
  { ts_code: '511380.SH', category: 'bond', name_hint: '转债ETF', benchmark_hint: '中证可转债及可交换债券', benchmark_index_code: null },
  { ts_code: '159649.SZ', category: 'bond', name_hint: '国开债ETF', benchmark_hint: '中债国开债', benchmark_index_code: null },
  // 黄金
  { ts_code: '518880.SH', category: 'gold', name_hint: '黄金ETF', benchmark_hint: '上海金', benchmark_index_code: null },
  { ts_code: '518800.SH', category: 'gold', name_hint: '黄金基金ETF', benchmark_hint: '上海金', benchmark_index_code: null },
  { ts_code: '159934.SZ', category: 'gold', name_hint: '黄金ETF（易方达）', benchmark_hint: '上海金', benchmark_index_code: null },
  // 跨境
  { ts_code: '513100.SH', category: 'cross_border', name_hint: '纳指ETF', benchmark_hint: '纳斯达克100', benchmark_index_code: null },
  { ts_code: '513500.SH', category: 'cross_border', name_hint: '标普500ETF', benchmark_hint: '标普500', benchmark_index_code: null },
  { ts_code: '513050.SH', category: 'cross_border', name_hint: '中概互联网ETF', benchmark_hint: '中国互联网50', benchmark_index_code: null },
  { ts_code: '159920.SZ', category: 'cross_border', name_hint: '恒生ETF', benchmark_hint: '恒生指数', benchmark_index_code: null },
  { ts_code: '513180.SH', category: 'cross_border', name_hint: '恒生科技ETF(QDII)', benchmark_hint: '恒生科技指数', benchmark_index_code: null },
  // 东财超级ETF免五白名单（宽基补充）
  { ts_code: '159205.SZ', category: 'broad_based', name_hint: '东财创业板ETF', benchmark_hint: '创业板指', benchmark_index_code: null },
  { ts_code: '159290.SZ', category: 'broad_based', name_hint: '东财创业板综合增强策略ETF', benchmark_hint: '创业板综', benchmark_index_code: null },
  { ts_code: '159330.SZ', category: 'broad_based', name_hint: '东财沪深300ETF', benchmark_hint: '沪深300', benchmark_index_code: '000300.SH' },
  { ts_code: '159337.SZ', category: 'broad_based', name_hint: '东财中证500ETF', benchmark_hint: '中证500', benchmark_index_code: '000905.SH' },
  { ts_code: '159380.SZ', category: 'broad_based', name_hint: '东财中证A500ETF', benchmark_hint: '中证A500', benchmark_index_code: null },
  { ts_code: '510140.SH', category: 'broad_based', name_hint: '华夏上证综合ETF', benchmark_hint: '上证指数', benchmark_index_code: '000001.SH' },
  { ts_code: '530050.SH', category: 'broad_based', name_hint: '东财上证50ETF', benchmark_hint: '上证50', benchmark_index_code: '000016.SH' },
  { ts_code: '589060.SH', category: 'broad_based', name_hint: '东财上证科创板综合价格ETF', benchmark_hint: '科创综指', benchmark_index_code: null },
  { ts_code: '589330.SH', category: 'broad_based', name_hint: '东财上证科创板200ETF', benchmark_hint: '科创200', benchmark_index_code: null },
  { ts_code: '589850.SH', category: 'broad_based', name_hint: '东财上证科创板50成份ETF', benchmark_hint: '科创50', benchmark_index_code: '000688.SH' },
  // 东财超级ETF免五白名单（行业/主题补充；159241.SZ 与 159278.SZ 已在上方声明）
  { ts_code: '158049.SZ', category: 'industry_theme', name_hint: '广发创业板算力基础设施ETF', benchmark_hint: '创业板算力', benchmark_index_code: null },
  { ts_code: '159045.SZ', category: 'industry_theme', name_hint: '大成中证稀有金属主题ETF', benchmark_hint: '稀有金属', benchmark_index_code: null },
  { ts_code: '159052.SZ', category: 'industry_theme', name_hint: '嘉实国证储能电池ETF', benchmark_hint: '储能电池', benchmark_index_code: null },
  { ts_code: '159107.SZ', category: 'industry_theme', name_hint: '富国创业板软件ETF', benchmark_hint: '创业板软件', benchmark_index_code: null },
  { ts_code: '159153.SZ', category: 'industry_theme', name_hint: '鹏华国证消费电子主题ETF', benchmark_hint: '消费电子', benchmark_index_code: null },
  { ts_code: '159160.SZ', category: 'industry_theme', name_hint: '东财中证电池主题ETF', benchmark_hint: '电池主题', benchmark_index_code: null },
  { ts_code: '159161.SZ', category: 'industry_theme', name_hint: '东财中证工程机械主题ETF', benchmark_hint: '工程机械', benchmark_index_code: null },
  { ts_code: '159207.SZ', category: 'industry_theme', name_hint: '广发中证智选高股息策略ETF', benchmark_hint: '智选高股息', benchmark_index_code: null },
  { ts_code: '159321.SZ', category: 'industry_theme', name_hint: '华安中证沪深港黄金产业股票ETF', benchmark_hint: '黄金产业股票', benchmark_index_code: null },
  { ts_code: '159549.SZ', category: 'industry_theme', name_hint: '天弘中证红利低波动100ETF', benchmark_hint: '红利低波100', benchmark_index_code: null },
  { ts_code: '159550.SZ', category: 'industry_theme', name_hint: '东财中证沪港深互联网ETF', benchmark_hint: '沪港深互联网', benchmark_index_code: null },
  { ts_code: '159599.SZ', category: 'industry_theme', name_hint: '东财中证芯片产业ETF', benchmark_hint: '芯片产业', benchmark_index_code: null },
  { ts_code: '159622.SZ', category: 'industry_theme', name_hint: '东财中证沪港深创新药产业ETF', benchmark_hint: '沪港深创新药', benchmark_index_code: null },
  { ts_code: '159637.SZ', category: 'industry_theme', name_hint: '东财中证新能源汽车ETF', benchmark_hint: '新能源汽车', benchmark_index_code: null },
  { ts_code: '159692.SZ', category: 'industry_theme', name_hint: '东财中证证券公司30ETF', benchmark_hint: '证券公司30', benchmark_index_code: null },
  { ts_code: '159994.SZ', category: 'industry_theme', name_hint: '银华中证5G通信主题ETF', benchmark_hint: '5G通信', benchmark_index_code: null },
  { ts_code: '510170.SH', category: 'industry_theme', name_hint: '国联安上证大宗商品股票ETF', benchmark_hint: '上证商品', benchmark_index_code: null },
  { ts_code: '515040.SH', category: 'industry_theme', name_hint: '华夏中证工业有色金属主题ETF', benchmark_hint: '工业有色', benchmark_index_code: null },
  { ts_code: '516150.SH', category: 'industry_theme', name_hint: '嘉实中证稀土产业ETF', benchmark_hint: '稀土产业', benchmark_index_code: null },
  { ts_code: '560480.SH', category: 'industry_theme', name_hint: '招商中证全指电力公用事业ETF', benchmark_hint: '电力公用', benchmark_index_code: null },
  { ts_code: '588750.SH', category: 'industry_theme', name_hint: '汇添富上证科创板芯片ETF', benchmark_hint: '科创芯片', benchmark_index_code: null },
];

/**
 * EXP-V3-01 超级 ETF 风格桶（来源：TactiCore `research/ashare/experiments/exp_v3_01_regime_super_etf.py:80-84`）。
 *
 * OFFENSIVE/STRUCTURAL 档按风格把权益部署预算拆为成长/价值两桶
 * （GROWTH_LEADING 65/35、VALUE_LEADING 35/65、其余 50/50），DEFENSIVE 档整体使用防御红利桶。
 * 桶内等权，不按启发式得分把预算集中到单一 ETF。
 */
export const V3_SUPER_ETF_VALUE_BUCKET: readonly string[] = ['159330.SZ', '530050.SH', '510140.SH'] as const;

export const V3_SUPER_ETF_GROWTH_BUCKET: readonly string[] = [
  '159205.SZ', '159337.SZ', '589850.SH', '159290.SZ', '589060.SH', '589330.SH',
] as const;

export const V3_SUPER_ETF_DEFENSIVE_BUCKET: readonly string[] = ['159549.SZ', '159207.SZ'] as const;

/** 已核验的东财超级 ETF 免五白名单（共 33 只，佣金万分之0.5，免5元最低消费）。 */
export const EASTMONEY_SUPER_ETF_CODES: readonly string[] = [
  '159052.SZ', '159207.SZ', '158049.SZ', '159045.SZ', '588750.SH',
  '159549.SZ', '159321.SZ', '560480.SH', '159107.SZ', '510170.SH',
  '516150.SH', '510140.SH', '515040.SH', '159161.SZ', '159205.SZ',
  '589330.SH', '589060.SH', '159330.SZ', '159337.SZ', '530050.SH',
  '159380.SZ', '159637.SZ', '159622.SZ', '159290.SZ', '159160.SZ',
  '159241.SZ', '159278.SZ', '159692.SZ', '589850.SH', '159153.SZ',
  '159994.SZ', '159599.SZ', '159550.SZ',
] as const;
