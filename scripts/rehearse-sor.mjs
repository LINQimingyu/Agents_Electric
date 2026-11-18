import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { delimiter, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { unzipSync } from 'fflate';
import { applyEdits, decodeCsv, sha256 } from '../electric-plugin/engineering.mjs';
import { gxStep } from '../electric-plugin/knowledge.mjs';

const home = resolve(process.env.AGENTS_ELECTRIC_HOME || '.local/dsh');
const root = resolve(process.argv[2] || 'D:/Users/h/Desktop/SOR1_BACKUP');
const projectName = 'SOR取消PanelID Demo';
const planName = '需求01改造方案.md';
const programs = ['04_CIM','07_DATA','10_SERVO','11_CCD','20_AA','22_AC','23_AD','24_AE','COMMENT'].map(name => name + '.csv');
const originals = new Map(await Promise.all(programs.map(async file => [file, await readFile(join(root, 'INPUT', file))])));
const proposal = await readFile(join(root, 'ANALYSIS', planName));
const file = '04_CIM.csv';
const rows = decodeCsv(originals.get(file)).value.split(/\r\n|\r|\n/);
const anchor = rows.findIndex(row => gxStep(row) === '9253' && row.includes('"SET"') && row.includes('"M22079"'));
assert(anchor >= 0, '应从原始程序定位到 P2017 的 M22079');
const before = rows[anchor];
assert(before.endsWith('""'));
const edit = { file, line: anchor + 1, before, after: before.slice(0, -1) + '【工作台流程测试注释】"' };
const question = '需求01：确认 H5_Sort01 的 AC1 Panel ID、AE1 SN 与 CIM 二次校验链路，定位 P2017、M22079/M22080、P2028 和退 Port。' +
  '本次验收工作台全链路，仅给候选加入非执行注释。原工程需求和设计以随附的需求01改造方案为准。';
const candidateBytes = applyEdits(originals.get(file), [edit], true).data;
const received = { knowledge: new Set(), queried: new Set() };
const summaries = new Map([
  ['原件核对 Agent', '已读取需求01以及 H5_Sort01 的九份 CSV；当前任务是核对 Panel ID 保持读取、CIM 比对异常和退 Port 链路。'],
  ['需求分析 Agent', '需求01要求区分 AC1 两次相关校验、AE1 本地比对和 Port 状态；保留 AC1 的读取和现有方案范围。'],
  ['基线分析 Agent', '按知识库线索，已从当前 04_CIM.csv 定位 P2017 的 M22079 指令。'],
  ['方案 Agent', '沿用已归档的需求01工程方案作为分析依据。工作台候选仅在已定位行的注释列加入测试标记。'],
  ['复核 Agent', '离线测试只更改末列注释，保持操作数、指令、步号和其他程序段一致。按结构检查和模拟验收推进。'],
]);

const mock = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') return res.end(JSON.stringify({ data: [{ id: 'sor-workflow-test', object: 'model' }] }));
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    const schema = input.tools?.find(tool => tool.function?.name === 'structured_output')?.function.parameters;
    const prompt = JSON.stringify(input.messages);
    const role = [...summaries.keys()].find(name => prompt.includes(`角色：${name}`));
    const verify = ['原件核对 Agent', '需求分析 Agent', '基线分析 Agent'].includes(role);
    if (verify && prompt.includes('设备知识线索') && prompt.includes('H5_Sort01') && prompt.includes('exact')) received.knowledge.add(role);
    const called = verify && input.messages.some(message => message.role === 'tool' && JSON.stringify(message).includes('M22079'));
    if (called) received.queried.add(role);
    const inspect = ['原件核对 Agent', '基线分析 Agent'].includes(role) && !called;
    const name = inspect ? 'plc_csv' : 'structured_output';
    let args;
    if (inspect) args = { path: file, startLine: edit.line, lineCount: 1 };
    else if (schema?.properties.edits) args = { summary: 'SOR 需求01全链路测试 · 仅增加一个 CSV 注释标记。', edits: [edit] };
    else if (schema?.properties.entries) args = { entries: [{ title: 'H5_Sort01 P2017 定位演练', category: '排查线索',
      meaning: '工作台测试从 H5_Sort01 的历史线索定位了当前 04_CIM.csv 中的 M22079 指令。',
      applicability: '仅限本次使用原始九份 CSV 的流程验收。', keywords: ['P2017', 'M22079', 'H5_Sort01'],
      anchor: 0, replaces: '' }] };
    else args = { summary: summaries.get(role) || '完成本次测试步骤。', findings: ['已按设备知识和本次程序定位。'], missing: [],
      ...(schema?.properties.programLocations ? { programLocations: [{ file, line: edit.line, sourceLine: before, meaning: 'P2017 资料检查通过标志的置位指令。' }] } : {}) };
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = 'call_' + randomUUID().slice(0, 8);
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000), model: input.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    send({ role: 'assistant' });
    if (schema) send({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    else send({ content: 'SOR 工作台验收模型。' });
    send({}, schema ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});

const live = await fetch('http://127.0.0.1:3080/').catch(() => null);
if (live) throw new Error('请先停止同一数据目录的本机工作台，再启动本次测试。');
await mkdir('.qa', { recursive: true });
const qa = await mkdtemp(resolve('.qa/sor-run-'));
let child;
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
try {
  const patch = join(qa, 'test-provider.yml');
  await writeFile(patch, `- id: llm-pi-ai
  config:
    providers:
      electric-sor-test:
        displayName: SOR 本机测试模型
        apiKeyEnv: ELECTRIC_SOR_TEST_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:${mock.address().port}/v1
        models:
          - id: sor-workflow-test
            name: SOR 本机测试模型
            contextWindow: 32000
`);
  const env = { ...process.env, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents-home'), ELECTRIC_SOR_TEST_KEY: 'local-test-only' };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
  env[pathKey] = resolve('node_modules/.bin') + delimiter + (env[pathKey] || '');
  child = spawn(process.execPath, [resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch,
    '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: join(home, 'electric', 'workspace'), env, windowsHide: true });
  const redact = value => value.replace(/token=[^\s&#]+/g, 'token=[redacted]');
  child.stderr.on('data', data => process.stderr.write(redact(String(data))));
  const login = await new Promise((success, reject) => {
    const timer = setTimeout(() => reject(new Error('本机测试服务启动超时。')), 25000);
    const lines = [];
    child.stdout.setEncoding('utf8').on('data', chunk => {
      lines.push(chunk);
      const match = lines.join('').match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (match) { clearTimeout(timer); success(new URL(match[1])); }
    });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`本机测试服务退出（${code}）。`)); });
  });
  const auth = await fetch(login, { redirect: 'manual' });
  assert.equal(auth.status, 303);
  const cookie = auth.headers.get('set-cookie').split(';')[0];

  async function request(path, body, expected = 200) {
    const response = await fetch(`${login.origin}/api/electric/${path}`, {
      headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    if (response.status !== expected) throw new Error(`${path} · ${response.status} · ${redact(await response.text())}`);
    return response.headers.get('content-type')?.includes('application/json') ? response.json() : Buffer.from(await response.arrayBuffer());
  }

  const overview = await request('overview');
  const project = overview.projects.find(item => item.name === projectName);
  assert(project?.hasArchive && project.deviceId === 'h5-sort01');
  const archive = await request(`project-archive?id=${project.id}`);
  const plan = archive.files.find(item => item.role === 'plan' && item.sourcePath === planName);
  assert.equal(sha256(proposal), plan?.digest, '应使用项目已确认的需求01方案版本');
  const id = randomUUID();
  const files = [...originals, [planName, proposal]].map(([path, data]) => ({ path, size: data.length, data: data.toString('base64') }));
  const run = await request('start', { id, projectId: project.id, templateId: 'plc-offline', testRun: true,
    provider: 'electric-sor-test', model: 'sor-workflow-test', authorized: true,
    materials: { requirements: question, folder: { name: 'SOR1_BACKUP', files } } });
  console.log(`测试运行 ${id} 已启动。`);

  async function until(predicate) {
    for (let attempt = 0; attempt < 140; attempt++) {
      const state = await request(`run?id=${id}`);
      if (predicate(state)) return state;
      if (state.checkpoint?.status === 'failed') throw new Error(`流程失败：${state.checkpoint.error}`);
      if (state.knowledgeDraft === 'failed') {
        const device = await request('knowledge?device=h5-sort01');
        throw new Error(device.drafts.find(item => item.runId === id)?.error || '测试知识草稿失败');
      }
      await delay(300);
    }
    throw new Error('等待测试节点超时。');
  }

  async function decide(node, note) {
    const state = await until(item => item.checkpoint?.nodeStates[node] === 'waiting' && item.gates.some(gate => gate.node === node));
    const gate = state.gates.find(item => item.node === node);
    await request('run', { id, op: 'decision', node, invocation: gate.invocation, action: 'approve', digest: gate.digest,
      approver: '工作台自动化测试', note });
    return state;
  }
  const intake = await until(item => item.checkpoint?.nodeStates.intake === 'waiting' && item.gates.length);
  const knowledge = intake.checkpoint.nodeOutputs.knowledge.knowledge;
  assert(knowledge.hits.some(hit => hit.match === 'exact' && hit.name === 'H5_Sort01'));
  assert.equal(intake.checkpoint.nodeOutputs['intake-check'].structured.programLocations[0].line, edit.line);
  console.log(`知识库命中 ${knowledge.hits.length} 条，原件已核对（GX 步号 9253 / CSV 第 ${edit.line} 行）。`);
  await decide('intake', '自动化流程测试确认了原始九份 CSV、需求01和设备知识引用。');
  await decide('plan-review', '测试候选仅在 04_CIM 的指定末列加入注释，验证候选和差异链路。');
  const checked = await until(item => item.checkpoint?.nodeStates.evidence === 'waiting' && item.candidate);
  const summary = checked.candidate;
  assert.equal(summary.diff.length, 1);
  assert.equal(summary.diff[0].after, edit.after);
  const candidate = unzipSync(await request(`download?id=${id}&kind=candidate`));
  assert.equal(Object.keys(candidate).length, originals.size);
  for (const [path, data] of originals) assert(Buffer.from(candidate[path]).equals(path === file ? candidateBytes : data), `${path} 包内字节正确`);
  assert.equal(received.knowledge.size, 3);
  assert.equal(received.queried.size, 2);
  console.log('并行核对、方案确认、候选差异和独立复核均完成。');

  async function record(kind, fileName, lines) {
    await request('run', { id, op: 'evidence', kind, source: 'test', digest: summary.digest, tool: 'Agents Electric 本机验收脚本',
      date: new Date().toISOString(), verdict: 'pass', fileName, fileData: Buffer.from(lines.join('\n')).toString('base64'),
      note: '工作台测试记录，工程验证状态为未验证。' });
  }
  await record('compile', '候选结构检查.txt', ['工作台测试 · 候选结构检查', '9 个文件均在候选包内；8 个文件逐字节一致。',
    `${file} 第 ${edit.line} 行仅末列注释变化，保留了指令和操作数。`, `候选 SHA-256 ${summary.digest}`]);
  assert.equal((await request(`run?id=${id}`)).checkpoint.nodeStates.evidence, 'waiting');
  await record('simulation', '模拟验收.txt', ['工作台测试 · 模拟验收', '已验证知识引用送达三类 Agent、两个阶段实际执行只读程序定位。',
    '通过本机模拟模型验证门禁、证据等待、测试交接和知识草稿。PLC 仿真状态为未执行。']);
  await decide('release', '工作台自动验收确认两个测试记录和候选摘要一致。');
  const finished = await until(item => item.checkpoint?.status === 'completed' && item.knowledgeDraft === 'review');
  assert(Object.values(finished.checkpoint.nodeStates).every(state => state === 'succeeded'));
  assert.deepEqual(finished.milestones.map(item => item.kind), ['tested']);
  await request('run', { id, op: 'milestone', kind: 'implemented', digest: summary.digest, note: '测试阻断检查' }, 409);
  const library = await request('knowledge?device=h5-sort01');
  const jobs = library.drafts.filter(job => job.runId === id);
  assert.equal(jobs.length, 1);
  assert(jobs[0].testRun);
  await request('knowledge', { op: 'publish', runId: id, expected: library.version, entries: jobs[0].entries }, 409);
  const handoff = await request(`download?id=${id}&kind=handoff`);
  const records = JSON.parse(Buffer.from(unzipSync(handoff)['工程记录.json']).toString('utf8'));
  assert.equal(records.verification, '工程未验证');
  assert.equal(records.testVerification, '测试通过');
  const out = join(home, 'electric', 'workspace', project.id, 'outputs', run.runId);
  const packagePath = join(out, 'SOR测试交接包.zip');
  await writeFile(packagePath, handoff, { flag: 'wx' });
  console.log(JSON.stringify({ runId: id, engineId: run.runId, packagePath, knowledgeHits: knowledge.hits.length, state: finished.checkpoint.status }));
} finally {
  if (child?.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
  await new Promise(done => mock.close(done));
}
