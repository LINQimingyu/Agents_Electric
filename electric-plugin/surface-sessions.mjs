import { randomUUID } from 'node:crypto';

function id(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.-]{1,180}$/.test(value)) throw new Error('会话标识无效。');
  return value;
}

function message(record) {
  const { event } = record;
  const raw = event.data.message || event.data;
  const header = { seq: event.seq, timestamp: event.time };
  if (event.type === 'tool/call') return { ...header, role: 'tool', label: `调用 ${raw.name}`,
    text: JSON.stringify(raw.arguments, null, 2)?.slice(0, 12000) || '', files: [] };
  if (event.type === 'tool/result') return { ...header, role: 'tool', label: raw.isError ? '工具执行异常' : '工具结果',
    text: (raw.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n').slice(0, 12000), files: [] };
  if (!['user/message', 'assistant/message'].includes(event.type)) return null;
  if (event.type === 'user/message' && raw.source?.kind === 'system-prompt') return null;
  const parts = raw.content || [];
  return { ...header, role: event.type === 'user/message' ? 'user' : 'assistant',
    text: parts.filter(part => part.type === 'text').map(part => part.text).join('\n'),
    files: parts.filter(part => ['file', 'image'].includes(part.type)).map(part => part.name || part.file?.name || part.attachment?.name || (part.type === 'image' ? '图片附件' : '文件附件')) };
}

export function registerSessionRoutes(ctx, route, publicMessage) {
  const pending = new Map();
  const managed = new Set();
  function wait(kind, request, next) {
    if (!request.agent?.session?.id || request.signal?.aborted) return next();
    const ticket = randomUUID();
    return new Promise(resolve => {
      const finish = result => {
        pending.delete(ticket);
        request.signal?.removeEventListener('abort', aborted);
        resolve(result);
      };
      const aborted = () => finish(kind === 'approval' ? 'cancelled' : { answers: [] });
      const view = { ticket, session: request.agent.session.id, parent: request.agent.session.header.parentSession,
        kind, tool: request.toolName, callId: request.callId,
        reason: publicMessage(request.displayReason?.['zh-CN'] || request.displayReason?.zh || request.reason), questions: request.questions };
      pending.set(ticket, { view, finish, aborted });
      request.signal?.addEventListener('abort', aborted, { once: true });
      if (request.signal?.aborted) aborted();
    });
  }
  ctx.on('approval/request', (request, next) => managed.has(request.agent?.session.id) ? wait('approval', request, next) : next(), true);
  ctx.on('user-questions/request', (request, next) => managed.has(request.agent?.session.id) ? wait('question', request, next) : next(), true);
  ctx.on('electric/workflow-question', request => wait('question', request, () => undefined));
  ctx.effect(() => () => { for (const item of pending.values()) item.aborted(); });

  route('questions', ['GET'], () => [...pending.values()].map(item => item.view)
    .filter(item => item.kind === 'question' && item.parent));

  route('sessions', ['GET', 'POST'], async (request, url) => {
    const session = ctx.sessionController;
    if (request.method === 'GET') {
      const selected = url.searchParams.get('id');
      const result = await session.list({}, request.signal);
      const sessions = result.items.map(row => ({ id: row.sessionId, parent: row.parentSessionId || null,
        title: row.projections?.values?.title || '',
        running: row.running, updatedAt: row.updatedAt }));
      if (!selected) return { sessions };
      const sessionId = id(selected);
      const parent = url.searchParams.get('parent') || sessions.find(row => row.id === sessionId)?.parent;
      const address = parent ? { kind: 'subagent', parentSessionId: id(parent), childSessionId: sessionId, mode: 'continuable' } :
        { kind: 'session', sessionId };
      const before = Number(url.searchParams.get('before'));
      const history = await session.events({ address, maxMessages: 50, ...(before > 0 ? { beforeSeq: before } : {}) }, request.signal);
      const state = await session.state({ sessionId }, request.signal).catch(() => ({ running: false }));
      const messages = history.records.map(message).filter(entry => entry && (entry.text || entry.files.length)).sort((a, b) => a.seq - b.seq);
      const reason = history.records.findLast(record => record.event.type === 'turn/end')?.event.data.reason;
      const tasks = [...pending.values()].map(item => item.view).filter(item => item.session === sessionId).map(item => {
        if (item.kind !== 'approval' || !item.callId) return item;
        const call = history.records.find(record => record.event.type === 'tool/call' && record.event.data.callId === item.callId)?.event.data;
        return { ...item, input: call?.arguments === undefined ? '' : JSON.stringify(call.arguments, null, 2).slice(0, 64000) };
      });
      return { sessions, messages, running: state.running, hasMore: history.hasMore,
        error: !state.running && reason?.kind === 'error' ? publicMessage(reason.error.message) : null,
        pending: tasks };
    }
    const body = await request.json();
    if (body.op === 'create') {
      const created = await session.create({ cwd: process.cwd() });
      const result = await session.resolveAgent(created.sessionId);
      if (result.agent) await ctx.sessions.flush(result.agent.session);
      return { id: created.sessionId };
    }
    const sessionId = id(body.id);
    if (body.op === 'rename') {
      const title = String(body.title || '').trim();
      if (!title || title.length > 120) throw new Error('请输入 1–120 字以内的标题。');
      return session.rename({ sessionId, title });
    }
    if (body.op === 'model') return session.selectModel({ sessionId, provider: String(body.provider), model: String(body.model) });
    if (body.op === 'stop') return session.cancel({ sessionId });
    if (body.op === 'answer') {
      const question = pending.get(body.ticket);
      if (!question || question.view.session !== sessionId) throw new Error('该待办已经结束。');
      if (question.submitting) throw new Error('此答复正在提交。');
      if (question.view.kind === 'approval') {
        if (!['allowed-once', 'rejected'].includes(body.outcome)) throw new Error('授权选择无效。');
        question.finish(body.outcome);
      } else {
        const answers = question.view.questions.map(item => {
          const answer = body.answers?.find(entry => entry.id === item.id);
          const selected = Array.isArray(answer?.selected) ? answer.selected : [];
          const custom = typeof answer?.custom === 'string' ? answer.custom.trim().slice(0, 4000) : '';
          if (selected.some(label => !item.options?.some(option => option.label === label)) ||
              (!item.multiSelect && selected.length > 1) || (item.intent?.kind === 'approval' && custom) ||
              (!selected.length && !custom)) throw new Error('请为每项待办填写有效答复。');
          return { id: item.id, selected, ...(custom ? { custom } : {}) };
        });
        question.submitting = true;
        try {
          if (question.view.parent) await ctx.serial('electric/workflow-answer', question.view, answers);
          if (!pending.has(body.ticket)) throw new Error('该待办已经结束。');
          question.finish({ answers });
        } finally { question.submitting = false; }
      }
      return { accepted: true };
    }
    if (body.op !== 'prompt') throw new Error('会话操作未知。');
    const prompt = typeof body.text === 'string' ? body.text.trim() : '';
    const files = Array.isArray(body.files) ? body.files.map(id) : [];
    if (prompt.length > 200000 || files.length > 12 || (!prompt && !files.length)) throw new Error('请输入消息或添加附件。');
    const content = prompt ? [{ type: 'text', text: prompt }] : [];
    for (const receiptId of files) content.push({ type: 'file', receiptId });
    managed.add(sessionId);
    return session.prompt({ sessionId, requestId: id(body.requestId), mode: 'queue', content }, request.signal);
  });
}
