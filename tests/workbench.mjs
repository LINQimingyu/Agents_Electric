import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { sample, sha256 } from '../electric-plugin/engineering.mjs';
import { baselineDigest, openKnowledge } from '../electric-plugin/knowledge.mjs';
import { importProjectArchive } from '../electric-plugin/project-archive.mjs';
import { makeZip } from '../electric-plugin/zip.mjs';
import { unzipSync } from 'fflate';

const cli = resolve('node_modules/@deepseek-ai/dsh/lib/bin.js');
await mkdir('.qa', { recursive: true });
const home = await mkdtemp(resolve('.qa/workbench-'));
const env = { ...process.env, AGENTS_ELECTRIC_HOME: home, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents-home'), ELECTRIC_QA_KEY: 'synthetic-testing-only' };
const logs = [];

function launch(args, cwd = process.cwd()) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const add = data => logs.push(String(data).replace(/token=[^\s&#]+/g, 'token=[redacted]'));
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  return child;
}

async function command(args) {
  const child = launch(args);
  const [code] = await once(child, 'exit');
  return code;
}

let listening;
let cookie;
let origin;
async function boot() {
  listening = launch([cli, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], join(home, 'electric', 'workspace'));
  const url = await new Promise((resolveUrl, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Timed out waiting for DSH')), 25000);
    listening.stdout.on('data', data => {
      output += data;
      const match = output.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (match) { clearTimeout(timeout); resolveUrl(new URL(match[1])); }
    });
    listening.once('exit', code => { clearTimeout(timeout); reject(new Error(`DSH exited ${code}`)); });
  });
  origin = url.origin;
  const response = await fetch(url, { redirect: 'manual' });
  assert.equal(response.status, 303);
  cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  return url;
}

async function stop() {
  if (listening && listening.exitCode === null && listening.signalCode === null) {
    const ended = once(listening, 'exit');
    listening.kill();
    await ended;
  }
}

async function request(path, body, expectStatus = 200) {
  const headers = { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) };
  const result = await fetch(`${origin}/api/electric/${path}`, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers });
  if (result.status !== expectStatus) throw new Error(`${path} returned ${result.status}: ${await result.text()}`);
  return result.headers.get('content-type')?.includes('application/json') ? result.json() : Buffer.from(await result.arrayBuffer());
}

async function until(id, predicate) {
  const start = Date.now();
  let last;
  while (Date.now() - start < 22000) {
    last = await request(`run?id=${id}`);
    if (predicate(last)) return last;
    if (last.checkpoint?.status === 'failed') throw new Error(`Workflow failed: ${last.checkpoint.error}\n${JSON.stringify(last.checkpoint.nodeStates)}`);
    await delay(300);
  }
  throw new Error(`Timed out: ${JSON.stringify(last?.checkpoint)}\n${JSON.stringify(last?.events?.slice(-10))}`);
}

let inFlight = 0;
let maxInFlight = 0;
const modelsSeen = new Set();
let folderDocumentSeen = false;
let programQuerySeen = false;
let clarificationSeen = false;
let downstreamClarificationSeen = false;
const secondProgram = 'Step,Instruction,Operand,Comment\r\n0,LD,X0,Start request\r\n1,AND,X2,Door interlock\r\n2,OUT,Y0,Cross block marker\r\n3,END,,\r\n';
const mock = createServer(async (req, res) => {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ data: [{ id: 'qa-chat', object: 'model' }, { id: 'qa-deepseek', type: 'model' }] }));
  }
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    modelsSeen.add(input.model);
    const asked = input.tools?.find(tool => (tool.function?.name || tool.name) === 'structured_output');
    const latest = input.messages?.at(-1);
    const approvalAsked = latest?.role === 'user' && JSON.stringify(latest.content).includes('界面授权测试')
      && input.tools?.some(tool => tool.function?.name === 'electric_qa_approval');
    const schema = asked?.function?.parameters || asked?.input_schema;
    const prompt = JSON.stringify(input.messages || []);
    const receivedAnswer = prompt.includes('QA-已核对的工具版本');
    if (receivedAnswer && prompt.includes('原件核对 Agent')) clarificationSeen = true;
    if (receivedAnswer && prompt.includes('需求分析 Agent')) downstreamClarificationSeen = true;
    const askClarification = prompt.includes('验收触发补充信息') && prompt.includes('原件核对 Agent') && !receivedAnswer &&
      input.tools?.some(tool => tool.function?.name === 'request_engineering_clarification');
    if (prompt.includes('2,OUT,Y0,Cross block marker') && prompt.includes('2,OUT,Y0,Demo status lamp')) programQuerySeen = true;
    const readPrograms = prompt.includes('原始需求.md') && prompt.includes('原件核对 Agent') && !programQuerySeen &&
      input.tools?.some(tool => tool.function?.name === 'plc_csv');
    const malformed = prompt.includes('验收模拟工具参数损坏') && prompt.includes('原件核对 Agent');
    if (prompt.includes('验收用 Word 需求正文') && prompt.includes('工程原件.gxw')) folderDocumentSeen = true;
    const intakeMissing = prompt.includes('原件核对 Agent') && prompt.includes('缺少验收条件标记');
    const fileChoices = schema?.properties.edits?.items.properties.file?.enum;
    const answer = schema?.properties.entries ? { entries: [{ title: '验收状态灯输出', category: '程序与软元件',
      meaning: '状态灯输出改在 Y1。', applicability: '已交付的验收样例', keywords: ['状态灯', 'Y1'], anchor: 0, replaces: 'status-light' }] } :
      schema?.properties.edits ? { summary: '替换状态灯输出，保留联锁。', edits: [
      { ...(fileChoices ? { file: '源程序/' + sample.fileName } : {}), line: 4, before: '2,OUT,Y0,Demo status lamp', after: '2,OUT,Y1,Demo status lamp' },
      ...(fileChoices ? [{ file: '其它.csv', line: 4, before: '2,OUT,Y0,Cross block marker', after: '2,OUT,Y2,Cross block marker' }] : []),
    ] } : { summary: '已核对当前阶段输入。', findings: ['保留启动输入 X0 与联锁 X2。'],
      ...(schema?.properties.programLocations ? { programLocations: [
        { file: sample.fileName, line: 3, sourceLine: '错引示例', meaning: '应被过滤。' },
        { file: sample.fileName, line: 4, sourceLine: '2,OUT,Y0,Demo status lamp', meaning: '状态灯输出。' },
      ] } : {}),
      missing: intakeMissing ? ['请补充状态灯验收条件。'] : [] };
    inFlight++;
    maxInFlight = Math.max(inFlight, maxInFlight);
    await delay(650);
    inFlight--;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const id = `tool_${randomUUID().slice(0, 12)}`;
    if (req.url.endsWith('/messages')) {
      const emit = (type, body) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`);
      emit('message_start', { message: { id, type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, usage: { input_tokens: 90, output_tokens: 0 } } });
      emit('content_block_start', { index: 0, content_block: asked ? { type: 'tool_use', id, name: 'structured_output', input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index: 0, delta: asked ? { type: 'input_json_delta', partial_json: malformed ? '{"summary":' : JSON.stringify(answer) } : { type: 'text_delta', text: 'QA 模型回应' } });
      emit('content_block_stop', { index: 0 });
      emit('message_delta', { delta: { stop_reason: asked ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } });
      emit('message_stop', {});
    } else {
      const emit = (delta, finish_reason) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: input.model,
        choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
      emit({ role: 'assistant' }, null);
      if (asked || approvalAsked || readPrograms || askClarification) emit({ tool_calls: [{ index: 0, id, type: 'function', function: {
        name: askClarification ? 'request_engineering_clarification' : readPrograms ? 'plc_csv' : asked ? 'structured_output' : 'electric_qa_approval',
        arguments: JSON.stringify(askClarification ? { questions: ['请确认工程工具版本。'] } :
          readPrograms ? { query: 'Y0' } : asked ? answer : {}),
      } }] }, null);
      else emit({ content: 'QA 模型回应' }, null);
      emit({}, asked || approvalAsked || readPrograms || askClarification ? 'tool_calls' : 'stop');
      res.write('data: [DONE]\n\n');
    }
    res.end();
  } catch (error) {
    logs.push(`Mock: ${error.message}`);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: error.message } }));
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const endpoint = `http://127.0.0.1:${mock.address().port}`;

const executablePath = process.env.ELECTRIC_CHROME || [
  'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find(existsSync);
let browser;
let freshProject, browserRun;
const metadata = { name: '三项信息项目验收', cpu: 'Q03UDVCPU', toolchain: 'GX Works2 1.610L' };
const runMaterials = { requirements: sample.requirements, fileName: sample.fileName, fileData: sample.fileData };
try {
  assert.equal(await command(['scripts/start.mjs', '--setup-only']), 0);
  const fixture = join(home, 'approval-fixture');
  await mkdir(fixture);
  await writeFile(join(fixture, 'package.json'), JSON.stringify({
    name: 'electric-approval-qa', version: '1.0.0', type: 'module', main: 'index.js', dsh: { bundle: { patch: './patch.yml' } },
  }));
  await writeFile(join(fixture, 'patch.yml'), '- insert:\n    - id: electric-approval-qa\n      name: electric-approval-qa\n');
  await writeFile(join(fixture, 'index.js'), `import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject = ['tools', 'approval'];
export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'electric_qa_approval', description: 'Exercise the approval UI without making changes.', parameters: {},
    output: { schema: { type: 'string' }, render: (_, value) => [{ type: 'text', text: value }] },
    async execute(_, exec) {
      return ctx.approval.request({ agent: exec.agent, callId: exec.callId, signal: exec.signal,
        toolName: 'electric_qa_approval', reason: '授权界面验收，无副作用' });
    },
  }));
}`);
  assert.equal(await command([cli, 'plugin', '--profile', 'web', 'add', 'link:' + fixture]), 0);
  await writeFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), `- id: llm-pi-ai
  config:
    providers:
      electric-qa:
        displayName: Local OpenAI QA
        apiKeyEnv: ELECTRIC_QA_KEY
        api: openai-completions
        baseURL: ${endpoint}/v1
        models:
          - id: qa-chat
            name: QA Chat
            contextWindow: 32000
- id: llm-deepseek
  config:
    apiKeyEnv: ELECTRIC_QA_KEY
    baseURL: ${endpoint}
    models:
      - id: qa-deepseek
        name: QA DeepSeek
        contextWindow: 32000
    reasoningEffort: off
`);
  const url = await boot();
  assert.equal((await fetch(`${origin}/api/electric/overview`)).status, 401);
  const unauthenticated = await fetch(origin);
  assert.equal(unauthenticated.status, 401);
  assert.match(await unauthenticated.text(), /Agents Electric/);
  const root = await fetch(origin, { headers: { Cookie: cookie } });
  assert.match(await root.text(), /<title>Agents Electric<\/title>/);
  const index = await fetch(`${origin}/index.html`, { headers: { Cookie: cookie } });
  assert.match(await index.text(), /<title>Agents Electric<\/title>/);
  const favicon = await fetch(`${origin}/electric-blank-v1.png`);
  assert.match(favicon.headers.get('content-type'), /image\/png/);
  const overview = await request('overview');
  assert(overview.templates.some(template => template.id === 'plc-offline' && template.publishedRevision === 1));
  const project = overview.projects.find(item => item.sample);
  assert(project);
  const analysis = join(home, 'test-analysis');
  await mkdir(join(analysis, 'segments'), { recursive: true });
  await writeFile(join(analysis, '方案.md'), '# 测试主方案\n');
  await writeFile(join(analysis, 'segments', '清单.txt'), '合成清单\n');
  const workspace = join(home, 'electric', 'workspace', project.id);
  const savedArchive = await importProjectArchive(workspace, analysis, '方案.md', ['segments/清单.txt']);
  assert.deepEqual(await importProjectArchive(workspace, analysis, '方案.md', ['segments/清单.txt']), savedArchive);
  assert((await request('overview')).projects.find(item => item.id === project.id).hasArchive);
  const archiveRoute = `project-archive?id=${project.id}`;
  const archive = await request(archiveRoute);
  const plan = archive.files.find(file => file.role === 'plan');
  assert.equal(plan.path, '交付物/方案.md');
  assert.equal((await request(`${archiveRoute}&file=${encodeURIComponent(plan.path)}`)).toString(), '# 测试主方案\n');
  const archiveZip = unzipSync(await request(archiveRoute + '&format=zip'));
  assert.equal(Buffer.from(archiveZip['生成物/segments/清单.txt']).toString(), '合成清单\n');
  await request(archiveRoute + '&file=../工程记录.json', undefined, 404);
  const knowledge = openKnowledge(home);
  const qaDevice = 'qa-sort';
  try {
    knowledge.seed(qaDevice, '验收分拣设备', [{ id: 'status-light', category: '程序与软元件', title: '状态灯 Y0',
      meaning: '状态灯由 Y0 输出。', applicability: '原始验收样例', keywords: ['状态灯', 'Y0'],
      baseline: baselineDigest([{ path: sample.fileName, digest: sha256(Buffer.from(sample.fileData, 'base64')) }]), status: 'static',
      positions: [{ file: sample.fileName, line: 4, step: null }], sources: [{ label: '方案.md', projectId: project.id, path: plan.path }],
    }], project.id);
  } finally { knowledge.close(); }
  const knowledgePath = `knowledge?device=${qaDevice}`;
  assert.equal((await request(knowledgePath + '&q=Y0')).entries[0].title, '状态灯 Y0');
  const options = await request('options');
  assert(options.skills.some(skill => skill.name === 'plc-change-review'));
  assert(options.groups.some(group => group.id === 'electric-qa'));
  assert(options.groups.some(group => group.id === 'deepseek-official'));
  const connections = await request('models');
  assert(connections.providers.some(provider => provider.id === 'deepseek-official'));
  assert(connections.providers.some(provider => provider.id === 'electric-qa'));
  assert(!JSON.stringify(connections).includes(env.ELECTRIC_QA_KEY));
  assert((await request('licenses')).every(item => item.text.includes('MIT')));
  console.log('✓ DSH 启动、内置模板、原生模型目录与 Skill 发现');

  if (executablePath && !process.argv.includes('--skip-ui')) {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    page.on('pageerror', error => logs.push(`Browser: ${error.message}`));
    url.hash = 'electric';
    await page.goto(url.toString());
    const frame = page;
    await frame.getByRole('heading', { name: 'PLC/HMI 离线变更' }).waitFor({ timeout: 18000 });
    assert.equal(await page.title(), 'Agents Electric');
    assert.equal(page.frames().length, 1);
    assert.equal(await page.locator('link[rel=icon]').getAttribute('href'), '/electric-blank-v1.png');
    assert.equal(await page.evaluate(async () => {
      const icon = await createImageBitmap(await (await fetch('/electric-blank-v1.png')).blob());
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.drawImage(icon, 0, 0);
      return ctx.getImageData(0, 0, 1, 1).data[3];
    }), 0);
    const blank = page.locator('.brand-mark');
    assert.equal((await blank.innerHTML()).trim(), '');
    await blank.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await blank.evaluate(button => getComputedStyle(button).outlineStyle), 'solid');
    await blank.press('Space');
    assert.equal(await blank.getAttribute('aria-expanded'), 'false');
    await blank.click();
    assert.equal(await blank.getAttribute('aria-expanded'), 'true');
    await page.reload();
    await page.getByRole('heading', { name: 'PLC/HMI 离线变更' }).waitFor();
    for (const [width, height] of [[1366, 768], [1920, 1080], [1093, 614], [820, 700], [390, 800]]) {
      await page.setViewportSize({ width, height });
      await delay(300);
      await page.screenshot({ path: join(home, `workbench-${width}.png`), animations: 'disabled' });
      for (const active of page.frames()) {
        assert.equal(await active.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, `horizontal overflow at ${width}`);
      }
    }
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.getByRole('button', { name: /调用设备知识库.*待开始/ }).click();
    await page.getByRole('button', { name: '启动流程', exact: true }).click();
    await page.getByRole('dialog', { name: '启动工作流' }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    const startButton = frame.getByRole('button', { name: '提交需求与原始程序' });
    await startButton.focus();
    await startButton.press('Enter');
    await frame.getByRole('dialog', { name: '启动工作流' }).waitFor();
    await frame.getByRole('button', { name: '取消', exact: true }).click();
    await frame.getByRole('button', { name: '工程项目' }).click();
    await frame.getByRole('button', { name: '交付物与生成物' }).click();
    const imported = frame.getByRole('dialog', { name: '交付物与生成物' });
    await imported.getByRole('link', { name: '方案.md' }).waitFor();
    await imported.getByText('生成物 · 1 个文件（含参考资料）').click();
    await imported.getByRole('link', { name: 'segments/清单.txt' }).waitFor();
    await imported.getByRole('button', { name: '关闭', exact: true }).click();
    await frame.getByRole('button', { name: 'PLC 知识库' }).click();
    await frame.getByRole('heading', { name: 'PLC 知识库' }).waitFor();
    await frame.getByLabel('关键词').fill('Y0');
    await frame.getByRole('button', { name: '搜索', exact: true }).click();
    await frame.getByText('状态灯 Y0', { exact: true }).click();
    await frame.getByRole('link', { name: '方案.md' }).waitFor();
    await frame.getByRole('button', { name: '工程项目' }).click();
    await frame.getByRole('button', { name: /新建项目/ }).click();
    const create = frame.getByRole('dialog', { name: '新建工程项目' });
    assert.equal(await create.locator('input, textarea, select').count(), 3);
    await create.getByLabel('项目名称').fill(metadata.name);
    await create.getByLabel('CPU 型号').fill(metadata.cpu);
    await create.getByLabel('工程工具及版本').fill(metadata.toolchain);
    await create.getByRole('button', { name: '创建项目' }).click();
    await frame.getByText('项目已创建。请在首节点提交需求与原始程序。').waitFor();
    await frame.getByRole('button', { name: '工程项目' }).click();
    await frame.getByRole('button', { name: '关联设备', exact: true }).click();
    await frame.getByRole('dialog', { name: '关联设备' }).getByLabel('设备', { exact: true }).selectOption(qaDevice);
    await frame.getByRole('button', { name: '保存关联' }).click();
    await frame.getByText('设备关联已保存。').waitFor();
    await page.reload();
    await frame.getByRole('button', { name: '提交需求与原始程序' }).click();
    const launch = frame.getByRole('dialog', { name: '启动工作流' });
    await launch.getByText('当前设备 · 验收分拣设备 v1').waitFor();
    assert.equal(await launch.locator('[name=projectId] option:checked').textContent(), metadata.name);
    await launch.getByLabel('离线变更需求').fill(runMaterials.requirements);
    await launch.getByLabel('原始程序 CSV', { exact: true }).setInputFiles({ name: runMaterials.fileName, mimeType: 'text/csv', buffer: Buffer.from(runMaterials.fileData, 'base64') });
    const choices = launch.locator('select[name=modelIndex] option');
    const model = choices.filter({ hasText: 'Local OpenAI QA' });
    await launch.locator('select[name=modelIndex]').selectOption(await model.getAttribute('value'));
    await launch.locator('input[name=authorized]').check();
    await launch.getByRole('button', { name: '启动', exact: true }).click();
    await frame.getByRole('button', { name: '审批通过' }).waitFor();
    await frame.getByText('当前任务', { exact: true }).waitFor();
    const updated = await request('overview');
    freshProject = updated.projects.find(item => item.name === metadata.name);
    browserRun = updated.runs.find(item => item.projectId === freshProject.id);
    assert(browserRun);
    await frame.getByRole('button', { name: '模型设置' }).click();
    await page.getByRole('heading', { name: '模型连接' }).waitFor();
    await page.getByRole('button', { name: '测试 Local OpenAI QA' }).click();
    await page.getByRole('button', { name: '执行测试' }).click();
    await page.getByText('模型连接测试通过。').waitFor();
    await page.getByRole('button', { name: '测试 DeepSeek', exact: true }).click();
    await page.getByRole('button', { name: '执行测试' }).click();
    await page.getByText('模型连接测试通过。').waitFor();
    await page.getByRole('button', { name: '添加连接' }).click();
    await page.getByLabel('连接标识').fill('electric-ui-qa');
    await page.getByLabel('连接名称').fill('界面连接验收');
    await page.getByLabel('服务地址').fill(endpoint + '/v1');
    await page.getByLabel('API Key').fill(env.ELECTRIC_QA_KEY);
    await page.getByLabel('模型 ID（每行一个）').fill('qa-chat');
    await page.getByRole('button', { name: '保存连接' }).click();
    await page.getByText('模型连接已保存。').waitFor();
    await page.getByRole('button', { name: '测试 界面连接验收' }).click();
    await page.getByRole('button', { name: '执行测试' }).click();
    await page.getByText('模型连接测试通过。').waitFor();
    const { id: chatId } = await request('sessions', { op: 'create' });
    await request('sessions', { op: 'rename', id: chatId, title: '界面会话验收' });
    await request('sessions', { op: 'model', id: chatId, provider: 'electric-qa', model: 'qa-chat' });
    await request('sessions', { op: 'prompt', id: chatId, text: '历史会话验收', requestId: randomUUID() });
    await page.getByRole('button', { name: 'Agent 会话' }).click();
    const historyDialog = page.getByRole('dialog', { name: '会话历史' });
    await historyDialog.getByLabel('搜索会话').fill('界面会话验收');
    await historyDialog.locator('[data-history-row]').filter({ hasText: '界面会话验收' }).getByRole('button', { name: '打开会话', exact: true }).click();
    const native = page.frameLocator('iframe[title="Agent 会话"]');
    await native.locator('[data-sidebar-toggle]').waitFor({ timeout: 15000 });
    const chatPage = page.frames().find(frame => new URL(frame.url()).pathname === '/agent-sessions');
    assert(chatPage);
    assert.equal(new URL(chatPage.url()).searchParams.get('session'), chatId);
    await native.getByText('历史会话验收', { exact: true }).first().waitFor({ timeout: 15000 });
    await native.getByText('QA 模型回应', { exact: true }).first().waitFor({ timeout: 15000 });
    const editor = native.getByRole('textbox', { name: /发消息或创建任务|send a message|message or create a task/i });
    await editor.fill('原生会话继续对话');
    await native.getByRole('button', { name: /发送消息|^send( message)?$/i }).click();
    await native.getByText('原生会话继续对话', { exact: true }).first().waitFor({ timeout: 15000 });
    await native.getByText('QA 模型回应', { exact: true }).nth(1).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.getByRole('button', { name: '关于' }).click();
    await page.getByRole('heading', { name: '开源许可' }).waitFor();
    await frame.getByRole('button', { name: '工作流模板' }).click();
    await frame.getByRole('button', { name: '添加 Skill' }).click();
    await frame.getByLabel('名称（小写字母、数字和连字符）').fill('electric-qa-review');
    await frame.getByLabel('用途描述').fill('验证表单新增 Skill');
    await frame.getByLabel('SKILL.md 正文').fill('记录核对结果。');
    await frame.getByRole('button', { name: '保存 Skill' }).click();
    await frame.getByRole('button', { name: '复制', exact: true }).click();
    await frame.getByLabel('模板名称').fill('试点验收副本');
    await frame.getByRole('button', { name: '需求核对', exact: true }).click();
    await frame.getByLabel('electric-qa-review', { exact: true }).check();
    await frame.getByRole('button', { name: '发布', exact: true }).click();
    await frame.getByText('模板 v1 已发布。', { exact: true }).waitFor({ timeout: 10000 });
    await frame.getByRole('button', { name: '插件管理' }).click();
    await page.getByRole('heading', { name: '插件管理' }).waitFor();
    console.log('✓ 三字段建项、流程首节点提交和 Agent 核对、模型与插件工作台入口');
  }

  freshProject ||= await request('project', metadata);
  if (!browser) await request('knowledge', { op: 'bind', projectId: freshProject.id, deviceId: qaDevice });
  assert.deepEqual([freshProject.name, freshProject.cpu, freshProject.toolchain], Object.values(metadata));
  assert.equal(freshProject.requirements, undefined);
  assert.equal(freshProject.digest, undefined);
  const id = browserRun?.id || randomUUID();
  const payload = { id, projectId: freshProject.id, templateId: 'plc-offline', provider: 'electric-qa', model: 'qa-chat', authorized: true, materials: runMaterials };
  await request('start', { ...payload, id: randomUUID(), materials: { requirements: runMaterials.requirements } }, 400);
  const started = await request('start', payload);
  assert.equal((await request('start', payload)).runId, started.runId);
  let current = await until(id, state => state.checkpoint?.nodeStates.intake === 'waiting' && state.gates?.length);
  assert.equal(current.checkpoint.nodeStates['intake-check'], 'succeeded');
  assert.equal(current.checkpoint.nodeOutputs.knowledge.knowledge.hits[0].match, 'exact');
  assert.equal(current.checkpoint.nodeOutputs['intake-check'].structured.programLocations[0].line, 4);
  assert.equal(current.checkpoint.nodeOutputs['intake-check'].structured.programLocations.length, 1);
  assert.equal(current.checkpoint.nodeStates.requirements, 'pending');
  assert.equal(current.project.requirements, runMaterials.requirements);
  const intake = current.gates.find(gate => gate.node === 'intake');
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(url.toString());
    const frame = page;
    await frame.getByRole('heading', { name: 'PLC/HMI 离线变更' }).waitFor();
    await frame.getByRole('button', { name: '运行记录' }).click();
    await frame.getByRole('button', { name: '查看运行' }).click();
    await frame.getByRole('button', { name: '审批通过' }).waitFor();
    await page.reload();
    await frame.getByRole('button', { name: '审批通过' }).waitFor();
    await delay(300);
    await page.screenshot({ path: join(home, 'workbench-waiting.png'), animations: 'disabled' });
    await page.close();
  }
  await stop();
  const resumedUrl = await boot();
  current = await request(`run?id=${id}`);
  assert.equal(current.gates[0].invocation, intake.invocation);
  const decide = async (snapshot, node, action = 'approve') => {
    const gate = snapshot.gates.find(item => item.node === node);
    return request('run', { id, op: 'decision', node, invocation: gate.invocation, action, digest: gate.digest, approver: '验收工程师', note: '自动化测试登记' });
  };
  if (browser) {
    const page = await browser.newPage();
    await page.goto(resumedUrl.toString());
    await page.getByRole('button', { name: '运行记录' }).click();
    await page.getByRole('button', { name: '查看运行' }).click();
    await page.getByRole('button', { name: '审批通过' }).click();
    const approval = page.getByRole('dialog', { name: '通过 · 原件放行' });
    await approval.getByLabel('审批人').fill('验收工程师');
    await approval.getByRole('button', { name: '确认通过' }).click();
    await page.getByText('已通过审批。', { exact: true }).waitFor();
    await page.close();
  } else await decide(current, 'intake');
  current = await until(id, state => state.checkpoint?.nodeStates['plan-review'] === 'waiting' && state.gates?.some(item => item.node === 'plan-review'));
  const approval = current.gates.find(gate => gate.node === 'intake').decision;
  assert.equal(approval.approver, '验收工程师');
  assert(Number.isFinite(approval.at));
  assert.equal(maxInFlight >= 2, true, 'two child agents overlap');
  const completedBeforeRestart = Object.fromEntries(['intake', 'requirements', 'baseline', 'plan'].map(node => [node, current.checkpoint.nodeAttempts[node]]));
  await stop();
  const finalUrl = await boot();
  await request('run', { id, op: 'resume' });
  current = await until(id, state => state.checkpoint?.nodeStates['plan-review'] === 'waiting');
  for (const [node, attempts] of Object.entries(completedBeforeRestart)) assert.equal(current.checkpoint.nodeAttempts[node], attempts);
  await decide(current, 'plan-review');
  current = await until(id, state => state.checkpoint?.nodeStates.evidence === 'waiting' && state.candidate);
  assert.match((await request(`download?id=${id}&kind=candidate`)).toString(), /OUT,Y1,/);
  assert.match((await request(`download?id=${id}&kind=baseline`)).toString(), /OUT,Y0,/);
  assert.equal((await request(`download?id=${id}&kind=handoff`)).readUInt32LE(0), 0x04034b50);
  const log = { id, op: 'evidence', kind: 'compile', digest: current.candidate.digest, tool: '模拟工具', date: new Date().toISOString(),
    verdict: 'pass', fileName: 'qa.log', fileData: Buffer.from('synthetic test evidence').toString('base64'), note: '自动化测试合成证据' };
  await request('run', { ...log, digest: '0'.repeat(64) }, 409);
  await request('run', log);
  assert.equal((await request(`run?id=${id}`)).checkpoint.nodeStates.evidence, 'waiting');
  await request('run', { ...log, kind: 'simulation' });
  current = await until(id, state => state.checkpoint?.nodeStates.release === 'waiting' && state.gates?.some(item => item.node === 'release'));
  await decide(current, 'release');
  current = await until(id, state => state.checkpoint?.status === 'completed');
  for (let attempt = 0; attempt < 40 && current.knowledgeDraft !== 'review'; attempt++) {
    await delay(250);
    current = await request(`run?id=${id}`);
    assert.notEqual(current.knowledgeDraft, 'failed', JSON.stringify((await request(knowledgePath)).drafts));
  }
  const beforePublish = await request(knowledgePath);
  assert.equal(beforePublish.drafts.length, 1);
  const [draft] = beforePublish.drafts;
  assert.equal(draft.state, 'review');
  assert.equal(draft.evidence.length, 2);
  assert.equal(draft.entries[0].positions[0].line, 4);
  assert.equal(beforePublish.entries[0].title, '状态灯 Y0');
  await request('run', { id, op: 'milestone', kind: 'accepted', digest: current.candidate.digest, note: '顺序验证' }, 409);
  for (const kind of ['implemented', 'accepted']) await request('run', { id, op: 'milestone', kind, digest: current.candidate.digest, note: '自动化测试登记' });
  assert.deepEqual((await request(`run?id=${id}`)).milestones.map(item => item.kind), ['delivered', 'implemented', 'accepted']);
  if (browser) {
    const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await page.goto(finalUrl.toString());
    await page.getByRole('button', { name: '运行记录' }).click();
    await page.getByRole('button', { name: '查看运行' }).click();
    await page.getByRole('button', { name: /需求核对.*已完成/ }).click();
    await page.getByRole('button', { name: '打开会话', exact: true }).click();
    const chat = page.frameLocator('iframe[title="Agent 会话"]');
    await chat.getByText(/角色：需求分析 Agent/).first().waitFor({ timeout: 15000 });
    await page.close();
  }
  console.log('✓ 原生子 Agent 并行、重复提交、人工等待重启恢复、候选与证据门禁');

  if (browser) {
    const page = await browser.newPage();
    await page.goto(finalUrl.toString());
    await page.getByRole('button', { name: 'PLC 知识库' }).click();
    await page.getByRole('button', { name: '审核', exact: true }).click();
    const review = page.getByRole('dialog', { name: '审核知识草稿' });
    await review.getByText('当前条目 · 状态灯 Y0').click();
    await review.getByText('状态灯由 Y0 输出。').waitFor();
    await review.getByRole('link', { name: '编译 · qa.log' }).waitFor();
    await review.getByLabel('标题', { exact: true }).fill('已审核状态灯输出');
    await review.getByRole('button', { name: '发布选中条目' }).click();
    await page.getByText('知识已发布。').waitFor();
    await page.close();
  } else {
    const entries = draft.entries.map(entry => ({ ...entry, title: '已审核状态灯输出' }));
    await request('knowledge', { op: 'publish', runId: id, expected: 1, entries });
  }
  const publishedKnowledge = (await request(knowledgePath)).drafts[0];
  assert.equal(publishedKnowledge.publishedVersion, 2);
  assert.equal((await request(knowledgePath)).entries[0].title, '已审核状态灯输出');
  assert.equal((await request(`run?id=${id}`)).checkpoint.nodeOutputs.knowledge.knowledge.hits[0].version, 1);
  const newer = randomUUID();
  await request('start', { ...payload, id: newer });
  const newerRun = await until(newer, state => state.checkpoint?.nodeStates.intake === 'waiting');
  assert.equal(newerRun.checkpoint.nodeOutputs.knowledge.knowledge.hits[0].version, 2);
  assert.equal(newerRun.checkpoint.nodeOutputs.knowledge.knowledge.hits[0].match, 'relocate');
  await request('run', { id: newer, op: 'cancel' });
  const another = await request('project', { ...metadata, name: '相似设备验收' });
  const otherRun = randomUUID();
  await request('start', { ...payload, id: otherRun, projectId: another.id, referenceDeviceId: qaDevice });
  const other = await until(otherRun, state => state.checkpoint?.nodeStates.intake === 'waiting');
  assert.equal(other.checkpoint.nodeOutputs.knowledge.knowledge.hits[0].match, 'reference');
  await request('run', { id: otherRun, op: 'cancel' });
  console.log('✓ 设备知识搜索、基线匹配、相似参考、完工草稿与版本固定');

  const probeId = randomUUID();
  const form = { id: 'qa-probe', name: 'DeepSeek 合成探针', description: '', plc: false, steps: [
    { id: 'probe', name: '探针', kind: 'agent', role: '测试 Agent', prompt: '返回一份测试分析。', depends: [], skills: [] },
  ] };
  await request('template', { form, expected: 0, publish: true });
  const probe = await request('start', { ...payload, id: probeId, templateId: form.id, provider: 'deepseek-official', model: 'qa-deepseek' });
  await until(probeId, state => state.checkpoint?.status === 'completed');
  const firstDraft = (await request('overview')).templates.find(template => template.id === form.id).draftRevision;
  form.name = 'DeepSeek 合成探针 v2';
  const newVersion = await request('template', { form, expected: firstDraft, publish: true });
  assert.equal(newVersion.publishedRevision, 2);
  assert.equal((await request(`run?id=${probeId}`)).item.revision, probe.revision);
  assert(modelsSeen.has('qa-chat') && modelsSeen.has('qa-deepseek'));
  console.log('✓ DSH OpenAI 兼容路由与 DeepSeek Messages 路由完成回环探针');

  const rejectedId = randomUUID();
  await request('start', { ...payload, id: rejectedId, sourceRunId: id, materials: { requirements: '缺少验收条件标记' } });
  const rejected = await until(rejectedId, state => state.checkpoint?.nodeStates.intake === 'waiting' && state.gates?.length);
  assert.deepEqual(rejected.gates[0].blockers, ['请补充状态灯验收条件。']);
  assert.equal(rejected.project.digest, current.project.digest);
  assert.equal((await request(`run?id=${id}`)).project.requirements, runMaterials.requirements);
  await request('run', { id: rejectedId, op: 'decision', node: 'intake', invocation: rejected.gates[0].invocation, action: 'approve' }, 400);
  await request('run', { id: rejectedId, op: 'decision', node: 'intake', invocation: rejected.gates[0].invocation, action: 'reject', note: '测试驳回' });
  const stopped = await until(rejectedId, state => state.checkpoint?.status === 'failed');
  assert.notEqual(stopped.checkpoint.nodeStates.requirements, 'succeeded');
  assert.equal(stopped.candidate, null);
  const advisoryId = randomUUID();
  await request('start', { ...payload, id: advisoryId, sourceRunId: id, materials: { requirements: '缺少验收条件标记' } });
  const advisory = await until(advisoryId, state => state.checkpoint?.nodeStates.intake === 'waiting' && state.gates?.length);
  const signed = await request('run', { id: advisoryId, op: 'decision', node: 'intake', invocation: advisory.gates[0].invocation, action: 'approve', approver: '验收工程师' });
  assert.equal(signed.approved, true);
  assert.equal(signed.approver, '验收工程师');
  assert.equal(signed.note, '');
  console.log('✓ 原件具名审批、审批留痕、Agent 核对建议、驳回停止下游');

  const word = makeZip([['word/document.xml',
    '<w:document><w:body><w:p><w:r><w:t>验收用 Word 需求正文</w:t></w:r><w:r><w:t> &amp; X2</w:t></w:r></w:p></w:body></w:document>']]);
  const gxwName = '源程序/工程原件.gxw';
  const incompleteId = randomUUID();
  await request('start', { ...payload, id: incompleteId, materials: { folder: { name: '工程资料', files: [
    { path: '变更需求.docx', size: word.length, data: word.toString('base64') },
    { path: gxwName, size: 26 },
  ] } } });
  const incomplete = await until(incompleteId, state => state.checkpoint?.nodeStates.intake === 'waiting' && state.gates?.length);
  assert(folderDocumentSeen);
  assert.equal(incomplete.project.folder.documents[0].text, '验收用 Word 需求正文 & X2');
  assert.equal(incomplete.project.folder.files.find(file => file.path === gxwName).state, 'listed');
  assert.equal(incomplete.project.digest, null);
  assert.match(incomplete.gates[0].blockers.join(' '), /导出原始程序 CSV/);
  assert.equal(incomplete.checkpoint.nodeStates.requirements, 'pending');
  await request('run', { id: incompleteId, op: 'decision', node: 'intake', invocation: incomplete.gates[0].invocation,
    action: 'approve', approver: '验收工程师' }, 409);
  await request(`download?id=${incompleteId}&kind=baseline`, undefined, 404);
  if (browser) {
    const root = join(home, '工程资料文件夹');
    await mkdir(join(root, '源程序'), { recursive: true });
    await writeFile(join(root, '原始需求.md'), sample.requirements);
    await writeFile(join(root, '源程序', sample.fileName), Buffer.from(sample.fileData, 'base64'));
    await writeFile(join(root, '其它.csv'), secondProgram);
    await writeFile(join(root, '注释.csv'), 'Address,Comment\r\nX0,Start\r\n');
    await writeFile(join(root, '源程序', '工程原件.gxw'), 'synthetic binary placeholder');
    const page = await browser.newPage();
    await page.goto(finalUrl.toString());
    await page.getByRole('button', { name: '提交需求与原始程序' }).click();
    const launch = page.getByRole('dialog', { name: '启动工作流' });
    await launch.locator('select[name=projectId]').selectOption(freshProject.id);
    await launch.getByLabel('选择资料文件夹').setInputFiles(root);
    await launch.getByText('工程资料文件夹 · 3 个 CSV · 1 份需求文档', { exact: true }).waitFor();
    const model = launch.locator('select[name=modelIndex] option').filter({ hasText: 'Local OpenAI QA' });
    await launch.locator('select[name=modelIndex]').selectOption(await model.getAttribute('value'));
    await launch.locator('input[name=authorized]').check();
    await launch.getByRole('button', { name: '启动', exact: true }).click();
    await page.getByRole('button', { name: '审批通过' }).waitFor();
    const run = (await request('overview')).runs[0];
    const captured = await request(`run?id=${run.id}`);
    assert(programQuerySeen);
    assert.equal(captured.project.folder.files.filter(file => file.digest).length, 3);
    assert.equal(captured.project.folder.documents[0].text, sample.requirements);
    const originalZip = unzipSync(await request(`download?id=${run.id}&kind=baseline`));
    assert.equal(Buffer.from(originalZip['源程序/' + sample.fileName]).toString('base64'), sample.fileData);
    assert.equal(Buffer.from(originalZip['其它.csv']).toString(), secondProgram);
    const pass = (stage, gate) => request('run', { id: run.id, op: 'decision', node: stage, invocation: gate.invocation, action: 'approve', approver: '验收工程师', note: '核对整组程序段' });
    await pass('intake', captured.gates.find(gate => gate.node === 'intake'));
    const reviewPlan = await until(run.id, state => state.gates.some(gate => gate.node === 'plan-review'));
    await pass('plan-review', reviewPlan.gates.find(gate => gate.node === 'plan-review'));
    const groupCandidate = await until(run.id, state => state.candidate);
    assert.deepEqual(new Set(groupCandidate.candidate.diff.map(row => row.file)), new Set(['其它.csv', '源程序/' + sample.fileName]));
    const candidateZip = unzipSync(await request(`download?id=${run.id}&kind=candidate`));
    assert.match(Buffer.from(candidateZip['其它.csv']).toString(), /OUT,Y2/);
    assert.match(Buffer.from(candidateZip['源程序/' + sample.fileName]).toString(), /OUT,Y1/);
    assert.deepEqual(candidateZip['注释.csv'], originalZip['注释.csv']);
    await page.close();
  }
  console.log('✓ 递归导入全部程序段、跨 CSV 查询、按文件生成差异、原件与候选完整导出');

  const malformedId = randomUUID();
  await request('start', { ...payload, id: malformedId, provider: 'deepseek-official', model: 'qa-deepseek',
    materials: { ...runMaterials, requirements: '验收模拟工具参数损坏' } });
  const malformedRun = await until(malformedId, state => state.checkpoint?.status === 'failed');
  assert.equal(malformedRun.checkpoint.nodeStates['intake-check'], 'failed');
  assert.equal(malformedRun.tasks['intake-check'].failure.code, 'MALFORMED_RESPONSE');
  assert.match(malformedRun.tasks['intake-check'].failure.detail, /tool input is invalid JSON/);
  assert(malformedRun.tasks['intake-check'].childSessionId);
  if (browser) {
    const page = await browser.newPage();
    await page.goto(finalUrl.toString());
    await page.getByRole('button', { name: '运行记录' }).click();
    await page.getByRole('button', { name: '查看运行' }).first().click();
    await page.getByText('失败任务', { exact: true }).waitFor();
    const task = page.locator('.task-card');
    await task.getByText('模型返回了无效的工具参数 JSON', { exact: true }).waitFor();
    await task.getByRole('button', { name: '查看 Agent 会话' }).waitFor();
    await task.getByRole('button', { name: '修正并重新核对' }).click();
    const launch = page.getByRole('dialog', { name: '启动工作流' });
    assert.equal(await launch.getByLabel('离线变更需求').inputValue(), '验收模拟工具参数损坏');
    assert.equal(await launch.locator('select[name=modelIndex] option:checked').textContent(), 'DeepSeek · QA DeepSeek');
    assert.equal(await launch.locator('input[name=authorized]').isChecked(), false);
    await page.close();
  }
  console.log('✓ 从实际子会话读取模型协议错误、任务卡显示原因与修正入口');

  const questionId = randomUUID();
  const asking = await request('start', { ...payload, id: questionId, materials: { ...runMaterials, requirements: '验收触发补充信息' } });
  if (browser) {
    const page = await browser.newPage();
    await page.goto(finalUrl.toString());
    const popup = page.getByRole('dialog', { name: 'Agent 需要补充信息' });
    await popup.getByText('请确认工程工具版本。').waitFor();
    await popup.getByLabel('补充信息', { exact: true }).fill('待补充草稿');
    await popup.getByRole('button', { name: '稍后回答' }).click();
    await page.getByRole('button', { name: '待回答 1' }).click();
    assert.equal(await popup.getByLabel('补充信息', { exact: true }).inputValue(), '待补充草稿');
    await page.reload();
    await popup.getByText('请确认工程工具版本。').waitFor();
    await popup.getByLabel('补充信息', { exact: true }).fill('QA-已核对的工具版本');
    await popup.getByRole('button', { name: '提交答复' }).click();
    await page.getByText('答复已送达 Agent。').waitFor();
    await popup.waitFor({ state: 'hidden' });
    await page.close();
  } else {
    let question;
    for (let attempt = 0; !question && attempt < 40; attempt++) {
      question = (await request('questions')).find(item => item.parent === asking.sessionId);
      if (!question) await delay(300);
    }
    assert(question);
    await request('sessions', { op: 'answer', id: question.session, ticket: question.ticket,
      answers: [{ id: '1', selected: [], custom: 'QA-已核对的工具版本' }] });
  }
  const answered = await until(questionId, state => state.gates.some(gate => gate.node === 'intake'));
  assert(clarificationSeen);
  const answeredGate = answered.gates.find(gate => gate.node === 'intake');
  await request('run', { id: questionId, op: 'decision', node: 'intake', invocation: answeredGate.invocation, action: 'approve', approver: '验收工程师', note: '已确认人工答复' });
  await until(questionId, state => state.gates.some(gate => gate.node === 'plan-review'));
  assert(downstreamClarificationSeen);
  console.log('✓ 工作流 Agent 提问弹窗、稍后答复、刷新恢复、进入原会话和下游节点');

  const history = await request('session-history');
  const storedChild = history.sessions.find(session => session.runId === id && session.title.includes('需求核对'));
  assert.equal(storedChild.parent, current.item.sessionId);
  assert(storedChild.id);
  if (browser) {
    const page = await browser.newPage();
    await page.goto(finalUrl.toString());
    await page.getByRole('button', { name: 'Agent 会话' }).click();
    const dialog = page.getByRole('dialog', { name: '会话历史' });
    await dialog.getByLabel('搜索会话').fill('界面会话验收');
    await dialog.locator('[data-history-row]').filter({ hasText: '界面会话验收' }).getByRole('button', { name: '打开会话', exact: true }).click();
    await page.frameLocator('iframe[title="Agent 会话"]').getByText('历史会话验收', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.getByRole('button', { name: 'Agent 会话' }).click();
    await dialog.getByLabel('搜索会话').fill('需求核对');
    await dialog.locator('[data-history-row]').filter({ hasText: '需求核对' }).first().getByRole('button', { name: '打开会话', exact: true }).click();
    await page.frameLocator('iframe[title="Agent 会话"]').getByText(/角色：需求分析 Agent/).first().waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: '返回工作台' }).click();
    await page.getByRole('button', { name: '运行记录' }).click();
    const row = page.locator('.list-item').filter({ hasText: '相似设备验收' });
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog', { name: '删除运行记录' }).getByRole('button', { name: '取消', exact: true }).click();
    await row.waitFor();
    await row.getByRole('button', { name: '删除', exact: true }).click();
    await page.getByRole('dialog', { name: '删除运行记录' }).getByRole('button', { name: '确认删除', exact: true }).click();
    await page.getByText('运行记录已删除。').waitFor();
    await row.waitFor({ state: 'hidden' });
    await page.reload();
    await page.getByRole('button', { name: '运行记录' }).click();
    assert.equal(await row.count(), 0);
    await page.close();
  } else await request('run', { id: otherRun, op: 'delete' });
  await request('run', { id: questionId, op: 'delete' });
  await request('run', { id: questionId, op: 'delete' });
  const remaining = (await request('overview')).runs;
  assert(!remaining.some(run => [otherRun, questionId].includes(run.id)));
  assert(remaining.some(run => run.id === id));
  assert.equal((await request(`run?id=${questionId}`)).checkpoint.status, 'cancelled');
  await request('run', { id: questionId, op: 'resume' }, 409);
  assert((await request(`download?id=${id}&kind=handoff`)).length > 0);
  assert.equal((await request('session-history')).sessions.some(session => session.runId === questionId), false);
  console.log('✓ 节点启动入口、普通与流程会话历史、运行记录删除和刷新持久化');

  if (browser && !process.argv.includes('--skip-plugins')) {
    const page = await browser.newPage();
    finalUrl.hash = 'electric';
    await page.goto(finalUrl.toString());
    const frame = page;
    await frame.getByRole('heading', { name: 'PLC/HMI 离线变更' }).waitFor({ timeout: 18000 });
    await frame.getByRole('button', { name: '插件管理' }).click();
    const engine = page.locator('.list-item').filter({ has: page.getByText('@gm-hz/agent-dag-workflow', { exact: true }) });
    await engine.getByRole('button', { name: '停用' }).click();
    await engine.getByText('已停用').waitFor();
    await page.getByRole('button', { name: '实施流程' }).click();
    await page.getByText(/流程编排暂不可用/).waitFor();
    await page.getByRole('button', { name: '插件管理' }).click();
    await engine.getByRole('button', { name: '启用' }).click();
    await engine.getByText('已启用').waitFor();
    await engine.getByRole('button', { name: '卸载' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '卸载' }).click();
    await engine.waitFor({ state: 'hidden' });
    const install = async spec => {
      await page.getByRole('button', { name: '安装插件' }).click();
      await page.getByRole('textbox', { name: '包名或安装地址' }).fill(spec);
      await page.getByRole('dialog').getByRole('button', { name: '检查插件' }).click();
    };
    const incompatible = join(home, 'incompatible');
    await mkdir(incompatible);
    await writeFile(join(incompatible, 'package.json'), JSON.stringify({ name: 'electric-incompatible-qa', version: '1.0.0', engines: { dsh: '99.0.0' }, dsh: { bundle: { patch: './patch.yml' } } }));
    await writeFile(join(incompatible, 'patch.yml'), '[]\n');
    await install(incompatible);
    await page.getByRole('dialog', { name: '确认安装插件' }).getByRole('button', { name: '安装', exact: true }).click();
    await page.getByRole('dialog').getByText(/不兼容|99\.0\.0|incompatible/i).first().waitFor({ timeout: 15000 });
    await page.keyboard.press('Escape');
    await install('@gm-hz/agent-dag-workflow@1.0.1');
    await page.getByRole('dialog', { name: '确认安装插件' }).getByRole('button', { name: '安装', exact: true }).click({ timeout: 25000 });
    await engine.getByRole('button', { name: '启用' }).click({ timeout: 25000 });
    await engine.getByText('已启用').waitFor({ timeout: 25000 });
    assert(await request('overview').then(result => result.runs.some(run => run.id === id)));
    console.log('✓ 工作台插件页启用、停用、卸载及重装，显示不兼容诊断');
  }
  console.log(`验收截图与隔离运行数据：${home}`);
} catch (error) {
  console.error(logs.join('').slice(-8500));
  console.error((error.stack || error.message).replace(/token=[^\s&#]+/g, 'token=[redacted]'));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop();
  mock.closeAllConnections();
  await new Promise(resolveClose => mock.close(resolveClose));
}
