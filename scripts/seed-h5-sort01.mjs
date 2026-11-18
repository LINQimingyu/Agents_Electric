import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeCsv, openEngineering, sha256 } from '../electric-plugin/engineering.mjs';
import { baselineDigest, categories, gxStep, openKnowledge } from '../electric-plugin/knowledge.mjs';
import { listProjectArchive, readArchivedFile } from '../electric-plugin/project-archive.mjs';

const root = resolve(process.argv[2] || 'D:/Users/h/Desktop/SOR1_BACKUP');
const home = resolve(process.env.AGENTS_ELECTRIC_HOME || fileURLToPath(new URL('../.local/dsh', import.meta.url)));
const store = openEngineering(home);
const knowledge = openKnowledge(home);
const overview = '程序逻辑梳理.md';
const flow = '现有流程_玻璃信息与两次读码.md';
const plan = '需求01改造方案.md';
const definitions = [
  ['stations', 0, 'AC1 与 AE1 的两次读码', 'AC1 通过 K2 读 Panel ID 并将 12 字符写入 D2393；AE1 通过 K3 读 SN，把数据写入 ZR26380 后调用 P2028，与 CIM 账料中的 Glass ID 比对。现有导出段未发现 AC1 码直接送入 AE1 比对的通路。', '改造前的 H5_Sort01 导出；区分两次读取、上位二次校验和本地账料比对。', ['AC1','AE1','Panel ID','SN站','两次读码','扫码','读码'], [['11_CCD',676,722],['04_CIM',9901,10030]], [[flow,'§3–4'],[overview,'§4.1–4.3'],['seg_11_CCD_扫码.txt','K2 / K3 接收']]],
  ['ac1', 0, 'AC1 流程、扫码与资料转移', 'D404 是 AC1 的流程状态，译码到 M2400 系列。进入读码判定时清 D2393 六个字；有效接收 D34811 或人工输入 D8200，均写入 D2393。AC1 资料块 D2300 搬到 AC2 后，同一字段落在 D2493。', 'AC1 自动流程；重读或人工补码按该站分支处理，校验进入另一个程序链路。', ['AC1','Panel ID','D404','D2393','D34811','D8200','D2300','D2493','W040'], [['22_AC',473,473]], [[overview,'§4.2'],['seg_22_AC_AC1自动.txt','D2393、M2414 相关梯级'],['关键软元件清单.txt','M2400–2499']]],
  ['ae1', 0, 'AE1 SN 读码、比对与放片顺序', 'D412 译码到 M3200 系列。状态 24 清接收区和 ZR26380、ZR26390；状态 26 将正常扫码或人工补码写入 ZR26380；CIM 开启时进入状态 28 比对。状态 34 等上报握手后执行 P2027 装载 AE1 资料，再进入放片流程。', 'AE1 自动状态 24、26、28、34 是 D412 的顺序值，GX Works2 的指令步号另行定位。', ['AE1','SN','D412','M3226','ZR26380','ZR26390','P2027','放片','CIM'], [['24_AE',541,947]], [[overview,'§4.3'],['seg_24_AE_自动.txt','M3224 / M3226 / M3228 / M3234'],['关键软元件清单.txt','M3200–3299']]],
  ['tracking', 0, '在籍标志与随片资料的去向', '07_DATA 的 P600 根据 D2100～D2900 各站资料块首字维护 L1～L9。部分 AC 区和 AD 区通过 100 words 资料块搬移。AE1 的 D2601 则由 P2027 从 CIM 在籍账料重新装载；未在这些导出段找到前站资料块直接搬入 AE1 的指令。', '以已导出的自动、手动搬移与账料子程序为边界。', ['P600','D2300','D2600','D2601','L3','L6','随片','在籍','资料转移'], [['07_DATA',160,209],['04_CIM',9879,9901]], [[flow,'§2'],[overview,'§3.2'],['seg_07_DATA_CIM在籍.txt','P600 / 站点在籍']]],
  ['blocks', 1, '程序段职责索引', '04_CIM 管通信与账料子程序，07_DATA 管在籍和手动资料转移，10_SERVO 管伺服，11_CCD 管扫码、相机和测高，20_AA 管 AA1/AA2，22_AC 管 AC1～AC4，23_AD 管 AD1 移载，24_AE 管 AE1。COMMENT.csv 保存软元件注释。', '8 个程序段和 1 份注释表，部分报警与初始化程序未在导出中。', ['CIM','DATA','SERVO','CCD','AC1','AE1','程序块','程序段','软元件注释'], [], [[overview,'§2.1'],['软元件注释表.txt','软元件注释索引']]],
  ['scanner', 1, 'K2 / K3 扫码接收区', '11_CCD 通过 SP.SOCRCV 将 AC1 的 K2 数据放在 D34811，将 AE1 的 K3 数据放在 D34911；触发前清接收区。AC1 和 AE1 分别读取自己的接收区，超时与接收异常走各自的报警。', '扫码器底层，以所选通信通道及有效值条件为准。', ['SP.SOCRCV','K2','K3','D34811','D34911','T1540','T1545','扫码器','读码失败'], [['11_CCD',636,746]], [[overview,'§4.1'],['seg_11_CCD_扫码.txt','step 636–746'],['rungs/11_CCD.txt','基恩士扫码']]],
  ['p2027', 1, 'P2027 装载 AE1 账料', 'AE1 在状态 34 调用 P2027，从 ZR60000Z1 搬 64 words 到 D2601；随后清来源账料、置 D2600 在籍并递减 ZR27134。D2612 是这份资料中的 Glass ID 字段；放片后有清 D2600 资料块的逻辑。', 'AE1 取片上报与资料交接；D2601 为资料起点，D2600 为块首标志。', ['AE1','P2027','D2600','D2601','D2612','ZR60000','ZR27134','清零','账料'], [['04_CIM',9879,9901],['24_AE',879,879]], [[overview,'§3.2、§4.3'],[flow,'§2、§4'],['flat/24_AE.txt','AE1 资料清理']]],
  ['p2028', 1, 'P2028 本地账料比对与 ZR27840', 'P2028 取当前片账料 ZR60011Z5 到 D8220，与 ZR26380 比较，L116 决定 12/13 字符条件。ZR27840=1 为当前片匹配，2 为在籍查得并换序，3 为未找到；AE1 根据结果继续或等待人工处理。', 'AE1 状态 28、CIM 开启。P2028 属于本地比对，CIM 的 Second Verify 使用另一套数据和响应。', ['P2028','AE1','ZR27840','ZR26380','ZR60011','D8220','L116','本地比对','Glass ID','比对'], [['04_CIM',9901,10030]], [[overview,'§5.1'],['seg_04_CIM_P2028.txt','P2028 梯级'],['rungs/04_CIM.txt','Other Sub Program']]],
  ['verify', 1, 'CIM 二次校验与状态上报使用不同缓冲', 'AC1 码随片到 D2493/D2793。ZR26990 保存送 CIM 做二次校验的六个字，ZR25300 承接响应；ZR27140 则在 Port 状态报告中保存 CST ID，可转入 ZR27102，在 Port K12 清零。L20014 是二次校验通过标志，被 AE1 与 AC2 的放行逻辑读取。', '参照 LD/ULD 各自的在籍触发；区分二次校验响应、CST ID 和 Port 状态。', ['Panel ID','Second Verify','ZR26990','ZR25300','ZR27140','ZR27102','L20014','二次校验','退Port','CIM'], [['04_CIM',4230,4364],['04_CIM',4956,5055]], [[overview,'§5.3、§5.5–5.6'],['seg_04_CIM_SecondVerify.txt','二次校验梯级']]],
  ['reports', 1, '扫码上报与下游资料出口', 'L20007 触发 Glass ID Read Report，ZR26380 进入 ZR21864，ZR26390 进入 ZR21874；上报状态消耗请求位。D2601 的资料分别供 Fetch Report、Process Data Report 和 LD Deliver To Sorter 使用。', '区分读到的码、账料字段与向下游交付的资料区。', ['L20007','ZR21864','ZR21874','D2601','D2612','上报','下游','Glass ID Read Report','Sorter'], [['04_CIM',3137,3291],['04_CIM',3777,3779],['04_CIM',10114,10119]], [[flow,'§5'],[overview,'§5.2'],['seg_04_CIM_GlassIDRead.txt','报文组包与握手']]],
  ['flow-stop', 2, '读码成功但不流片的排查顺序', '先区分 AC1 只读码成功与 AE1 本地比对。核对 AE1 的 ZR27840 和状态 34 的 M20160、L20007、T544，再沿 Port 状态查看 P2017 的 M22079。M22079 是 Port 从 MPEN 进入 K4 的条件之一。', '结合当前停留状态和当前程序，逐段确认；单一读码成功信号不足以表明允许流片。', ['读码成功','不流片','P2017','M22079','ZR27840','MPEN','T544','Port'], [['04_CIM',5184,5190],['04_CIM',9246,9255]], [[plan,'§2.1–2.2，改造前逻辑'],[overview,'§4.3、§5.1']]],
  ['cancel', 2, '校验异常后退 Port 的独立入口', '现状有 P2017 下载资料检查和 Second Verify 的独立触发链。P2017 每次先清检查位，最终同一条件组判定 M22079 与 M22080；Second Verify 的超时或 NG 经 M8756/M8758 进入 Port Cancel 分支。ZR27100 是 Port 状态号，K6 对应 CAEN。', '按当前 Port 模式、报警和条件查入口；区分 AC2 退 Port 报警及尚未定位的上游映射。', ['退Port','退 Port','异常','取消PanelID','P2017','M22080','M22079','M8758','M8756','ZR27100','W258'], [['04_CIM',5249,5272],['04_CIM',9113,9256]], [[plan,'§2.1、§2.3、§4 现状链路'],[overview,'§5.6'],['find_报警链.txt','报警引用结果']]],
  ['open-points', 2, '报警锁存与 HMI 写入来源待核实', '已导出程序中可定位 M8546/M8547 的复位和引用，未看到对应置位来源。D2669.0/.1 的 HMI 写入亦待确认；D2670 属于会被清空的 D2600 资料块。', '定位 HMI 工程或补齐缺失程序块后复核。', ['M8546','M8547','W046','W047','D2669','D2670','HMI','待核实','报警'], [['24_AE',905,908]], [[overview,'§4.3、§7'],['引用位置.txt','M8546 / M8547 / D2669 跟踪'],['注释筛选.txt','软元件注释']], 'pending'],
];

try {
  const projects = store.projects().filter(project => project.name === 'SOR取消PanelID Demo');
  if (projects.length !== 1) throw new Error('未找到唯一的 SOR取消PanelID Demo 项目。');
  const workspace = store.workspace(projects[0].id);
  const archive = await listProjectArchive(workspace);
  const archived = new Map(archive.files.map(file => [file.sourcePath, file]));
  const files = ['04_CIM','07_DATA','10_SERVO','11_CCD','20_AA','22_AC','23_AD','24_AE','COMMENT'].map(name => name + '.csv');
  const indexes = new Map();
  const hashes = [];
  for (const path of files) {
    const data = await readFile(join(root, 'INPUT', path));
    hashes.push({ path, digest: sha256(data) });
    const steps = new Map();
    decodeCsv(data).value.split(/\r\n|\n|\r/).forEach((row, index) => {
      const step = gxStep(row);
      if (step !== null && !steps.has(Number(step))) steps.set(Number(step), index + 1);
    });
    indexes.set(path, steps);
  }
  for (const name of new Set(definitions.flatMap(definition => definition[7].map(([file]) => file)))) {
    const original = await readFile(join(root, 'ANALYSIS', name));
    if (!archived.has(name) || !original.equals(await readArchivedFile(workspace, archived.get(name)))) {
      throw new Error(`项目归档与分析来源不一致：${name}`);
    }
  }
  const baseline = baselineDigest(hashes);
  const entries = definitions.map(([id, category, title, meaning, applicability, keywords, anchors, sources, status = 'static']) => ({
    id, category: categories[category], title, meaning, applicability, keywords, baseline, status,
    positions: anchors.map(([program, from, to]) => {
      const file = program + '.csv';
      const steps = indexes.get(file);
      const line = steps.get(from);
      return { file, step: String(from), ...(from !== to ? { endStep: String(to) } : {}),
        ...(line ? { line } : {}), ...(from !== to && steps.has(to) ? { endLine: steps.get(to) } : {}) };
    }),
    sources: sources.map(([source, section]) => ({ label: source, section, projectId: projects[0].id, path: archived.get(source).path,
      digest: archived.get(source).digest })),
  }));
  const version = knowledge.seed('h5-sort01', 'H5_Sort01', entries, projects[0].id);
  console.log(`H5_Sort01 v${version.version} · ${version.entries.length} 条设备知识`);
} finally { knowledge.close(); store.close(); }
