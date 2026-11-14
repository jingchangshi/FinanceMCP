#!/usr/bin/env node
// The CLI writes progress to stderr and machine-readable results to stdout. The
// override must run before any module (config.ts logs at import time) is loaded.
console.log = (...args: unknown[]) => { if (process.env.ASHARE_VERBOSE) console.error(...args); };

const USAGE = `用法: finance-ashare <command> [options]

  sync --start YYYYMMDD [--end YYYYMMDD] [--force] [--no-fina]   批量同步区间内的交易日数据
  daily [--date YYYYMMDD]                                        定时任务入口：同步 → 分析 → 发布当日报告
  report --date YYYYMMDD                                         仅基于本地缓存生成指定交易日报告（始终写入研究库，不改动正式数据）
  replay --start YYYYMMDD --end YYYYMMDD                         历史日期重放（研究库 research.sqlite，不改动正式数据）
  evidence [--start YYYYMMDD] [--end YYYYMMDD]                   计算信号历史效果统计（样本内）
  pool-eval --start YYYYMMDD --end YYYYMMDD [--horizon 5] [--research]  股票池历史实际表现（截至 end，研究记录）
  status [--date YYYYMMDD]                                       数据完整性状态
  etf-sync --start YYYYMMDD [--end YYYYMMDD] [--refresh]         同步五只 ETF 的基础信息/日线/复权/份额（独立 fund_* 表）
  etf-status [--date YYYYMMDD]                                   ETF 数据状态（最新日线、逐只就绪度、份额可得性）
  etf-quotes [--codes a,b] [--start YYYYMMDD] [--end YYYYMMDD] [--adjust none|qfq|hfq]   ETF 行情快照（含单位换算、复权、份额、质量标记与 fee 基金费率块）
  acceptance [--days 3] [--end YYYYMMDD] [--allow-degraded]      连续真实交易日验收（两次定时运行、当日复查行情、最终 READY、MCP 一致、股票池连续）
  quality --date YYYYMMDD                                        重新执行数据质量检查
  audit [--start YYYYMMDD] [--end YYYYMMDD] [--fix]              历史缓存缺口审计（停牌/退市/真实缺口），--fix 只补齐缺失部分
  research-snapshot --date YYYYMMDD [--db PATH] [--revise] [--horizon 10]
                                                                 保存指定交易日的 V1/V2 前瞻研究快照（只读正式库，写入独立研究库）
  research-evaluate --date YYYYMMDD [--db PATH] [--as-of YYYYMMDD] [--horizon 10]
                                                                 用已保存的快照评价持有期收益；未到期保持 PENDING
  research-seed --date YYYYMMDD [--db PATH]                      以该日正式 V1 股票池写入一次性 V1/V2 共同起点（只读正式库）
  research-cadence <weekly|monthly> --as-of YYYYMMDD|latest --account-id ID [--dry-run]
                                                                 周/月研究节奏报告（默认禁用，需 RESEARCH_CADENCE_ENABLED=1；只读行情与账户库）
  research-export [--date YYYYMMDD] --output DIR [--datasets a,b] [--allow-missing-bars]
                                                                 只读研究数据冻结快照导出（生产库只读，as-of 之后的数据拒绝导出）
  investment-research-bundle [--account ID] [--date YYYYMMDD] [--db PATH] [--market-db PATH]
                                                                 私有统一研究事实包；默认最近已收盘日，读取路径不写库
  hotspot-sync [--start YYYYMMDD] [--end YYYYMMDD] [--ths-codes a,b]  显式联网同步热点行业数据（申万L1/L2/L3+成分+指数日线、同花顺目录/成分/指数日线；绝不接入 daily；THS 成分恒为 NO_POINT_IN_TIME）
  hotspot-snapshot [--date YYYYMMDD] [--dry-run] [--full]         生成热点行业 + V2 五族技术视图 + 每股唯一研究状态，写入 hotspot_* 研究表（只写新表；默认只打印摘要，--full 打印全文）
  technical-preview --date YYYYMMDD [--db PATH] [--json|--md] [--out DIR]
                                                                 只读技术方法 V2 预览：五类策略候选 + 共享量价上下文；默认不持久化
  technical-study --dates YYYYMMDD[,YYYYMMDD...] | --start/--end [--as-of YYYYMMDD] [--horizons 3,5,10,20]
                                                                 V2 候选的描述性前瞻观察（只读；复用 T+1/费用/3-20日评价与三组对照）
  migrate                                                        将旧版缓存主键布局迁移为按股票连续存储

  账户子命令（独立 portfolio.sqlite，只读演示账户，默认不在 MCP 暴露）：
  portfolio-import                                               导入 PRD §3 基线快照（幂等）
  portfolio-summary [--snapshot ID]                              账户汇总：市值/权重/集中度/主题暴露/对账
  portfolio-scenario --action hold|sell-buy [--sell CODE --buy CODE --shares N ...]
                                                                 静态换仓情景（确定性，不下单）
  portfolio-decision --account ID --action hold|reduce|sell-buy|no-action [--sell CODE --shares N]
        [--buy CODE] [--market-db PATH]                          条件化配置比较（候选行情只来自服务端缓存）
  portfolio-strategy-admission <grant|pause|resume|revoke|status>  本地策略准入记录
  portfolio-strategy-feedback <import|list>                      本地策略反馈事件
  portfolio-news-evidence <import|list>                          本地可核验消息/公告证据`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function ymd(value: string | undefined, label: string): string {
  if (!value || !/^\d{8}$/.test(value)) throw new Error(`${label} 需要 YYYYMMDD 格式`);
  return value;
}

const print = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const { openAshareDb } = await import('./db.js');
  const { checkQuality, shanghaiToday } = await import('./ingest.js');
  const { syncRange } = await import('./sync.js');
  const command = process.argv[2];
  if (command === 'investment-research-record') {
    const { runBundleRecordCommand } = await import('../portfolio/bundleRecordCli.js');
    runBundleRecordCommand({ arg, flag, ymd, print });
    return;
  }
  if (command === 'investment-research-bundle') {
    const { runBundleCommand } = await import('../portfolio/bundleCli.js');
    runBundleCommand({ arg, flag, ymd, print });
    return;
  }
  if (command?.startsWith('portfolio-journal-')) {
    const { runJournalCommand } = await import('../portfolio/journalCli.js');
    if (!runJournalCommand(command, { arg, flag, ymd, print })) process.exitCode = 2;
    return;
  }
  if (command === 'research-validation') {
    const { runValidationCommand } = await import('./validationCli.js');
    print(await runValidationCommand(process.argv.slice(3)));
    return;
  }
  // Research commands open the live cache read-only themselves and must not
  // create or migrate a writable live connection.
  if (command === 'research-snapshot' || command === 'research-evaluate' || command === 'research-seed') {
    const { runCommand } = await import('./commands.js');
    if (!(await runCommand(undefined as any, command, { arg, flag, ymd, print }))) process.exitCode = 2;
    return;
  }
  // The research export also opens the live cache read-only itself (it needs its
  // own as-of cutoff check before any file is written), so it is handled here
  // too rather than falling through to openAshareDb().
  if (command === 'research-export') {
    const { runResearchExportCommand } = await import('./researchExport.js');
    print(await runResearchExportCommand(process.argv.slice(3)));
    return;
  }
  // Weekly/monthly research cadence: disabled unless RESEARCH_CADENCE_ENABLED=1, opens the
  // market cache and the ledger read-only, and handles its own databases (so it must run
  // before openAshareDb(), which would create or migrate a writable live connection).
  if (command === 'research-cadence') {
    const { runCadenceCommand } = await import('./researchCadenceCli.js');
    print(await runCadenceCommand(process.argv.slice(3)));
    return;
  }
  // V2 technical preview is read-only by construction: it opens the cache with
  // SQLite readOnly and must never fall through to openAshareDb() (which can
  // create or migrate a writable connection).
  if (command === 'technical-preview') {
    const { runTechnicalPreviewCommand } = await import('./technicalPreviewCli.js');
    print(runTechnicalPreviewCommand(process.argv.slice(3)));
    return;
  }
  if (command === 'technical-study') {
    const { runTechnicalStudyCommand } = await import('./technicalStudy.js');
    print(runTechnicalStudyCommand(process.argv.slice(3)));
    return;
  }
  if (command === 'portfolio-strategy-admission') {
    const { handleStrategyAdmission } = await import('./strategyAdmissionCli.js');
    const result = handleStrategyAdmission(process.argv.slice(3));
    print(result);
    if (typeof result === 'object' && result !== null && 'admitted' in result && !result.admitted) process.exitCode = 1;
    return;
  }
  if (command === 'portfolio-strategy-feedback') {
    const { runStrategyFeedbackCli } = await import('../portfolio/strategyFeedbackCli.js');
    print(runStrategyFeedbackCli(process.argv.slice(3)));
    return;
  }
  if (command === 'portfolio-news-evidence') {
    const { runNewsEvidenceCommand } = await import('../portfolio/newsEvidenceCli.js');
    const sub = process.argv[3] === 'import' ? 'news-evidence-import'
      : process.argv[3] === 'list' ? 'news-evidence-list' : null;
    if (!sub) throw new Error('usage: portfolio-news-evidence <import|list> ...');
    if (!runNewsEvidenceCommand(sub, { arg, flag, ymd, print })) process.exitCode = 2;
    return;
  }
  // Account commands only touch the separate portfolio database. They must not
  // open (or create) the market cache, so they are handled before openAshareDb.
  if (command?.startsWith('portfolio-')) {
    const { runPortfolioCommand } = await import('../portfolio/cli.js');
    if (!runPortfolioCommand(command, { arg, flag, ymd, print })) {
      process.stderr.write(USAGE + '\n');
      process.exitCode = 2;
    }
    return;
  }
  const db = openAshareDb();
  switch (command) {
    case 'sync': {
      const start = ymd(arg('start'), '--start');
      const end = arg('end') ? ymd(arg('end'), '--end') : shanghaiToday();
      const summary = await syncRange(db, start, end, { force: flag('force'), fina: !flag('no-fina') });
      print(summary);
      break;
    }
    case 'migrate': {
      const { migrateAshareDb } = await import('./db.js');
      print({ migrated: migrateAshareDb(db) });
      break;
    }
    case 'quality': {
      print(checkQuality(db, ymd(arg('date'), '--date')));
      break;
    }
    default: {
      const { runCommand } = await import('./commands.js');
      if (!command || !(await runCommand(db, command, { arg, flag, ymd, print }))) {
        process.stderr.write(USAGE + '\n');
        process.exitCode = 2;
      }
    }
  }
  db.close();
}

main().catch(error => {
  process.stderr.write(`[ashare] 失败: ${error?.stack || error}\n`);
  process.exitCode = 1;
});
