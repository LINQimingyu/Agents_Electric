export function publicMessage(value) {
  return String(value ?? '').replace(/DeepSeek Harness|\bDSH\b/gi, '运行时')
    .replace(/(https?:\/\/)[^\/\s@]+@/gi, '$1[已隐藏]@')
    .replace(/([?&](?:token|api[-_]?key|password)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/\b(?:Bearer\s+[\w.~-]+|sk-[\w-]{8,})/gi, '[已隐藏]');
}

export function failureDetails(failure, fallback) {
  const code = publicMessage(failure?.code).slice(0, 100);
  const detail = publicMessage(failure?.message || fallback).slice(0, 4000);
  const description = code + ' ' + detail;
  if (/tool input.*invalid JSON|invalid JSON.*tool (?:input|arguments)/i.test(description)) {
    return { code, detail, title: '模型返回了无效的工具参数 JSON',
      next: '沿用本次资料重新运行。若再次出现，切换到另一个支持工具调用的模型。' };
  }
  if (/context.length|context window|too many tokens|CONTEXT_LIMIT/i.test(description)) {
    return { code, detail, title: '本次输入超出模型上下文限制', next: '缩小本次程序范围，或选择上下文容量更大的模型。' };
  }
  if (/\b429\b|rate.?limit|too many requests/i.test(description)) {
    return { code, detail, title: '模型服务暂时限流', next: '稍后用本次资料重试，或切换到另一个可用模型。' };
  }
  if (/\b(?:401|403)\b|\bunauthorized\b|invalid api.?key|authentication/i.test(description)) {
    return { code, detail, title: '模型服务拒绝了本次请求', next: '在模型设置测试本次连接，检查登录、密钥与模型访问权限。' };
  }
  return { code, detail, title: failure ? 'Agent 执行未完成' : '节点执行未完成', next: '查看下面的报错或 Agent 会话，根据具体信息调整后重新运行。' };
}
