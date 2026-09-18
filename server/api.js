const crypto = require('crypto');
const { load, save } = require('./store');

// 允许的请求方式，与页面上的下拉选项保持一致
const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

const MAX_NAME_LENGTH = 60;
const MAX_URL_LENGTH = 2048;
const MAX_BODY_LENGTH = 200 * 1024;
const MAX_HEADER_COUNT = 30;

// 带错误码与出错位置的业务异常，页面据此把问题标到具体输入项上
class ApiError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.field = field || '';
  }
}

function pickText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validateMethod(method) {
  const value = pickText(method).toUpperCase();
  if (!value) throw new ApiError(400, 'METHOD_REQUIRED', '请选择请求方式', 'method');
  if (!ALLOWED_METHODS.includes(value)) {
    throw new ApiError(400, 'METHOD_INVALID', `不支持的请求方式：${value}`, 'method');
  }
  return value;
}

function validateName(name) {
  const value = pickText(name);
  if (!value) throw new ApiError(400, 'NAME_REQUIRED', '请填写用例名称', 'name');
  if (value.length > MAX_NAME_LENGTH) {
    throw new ApiError(400, 'NAME_TOO_LONG', `用例名称不能超过 ${MAX_NAME_LENGTH} 个字符`, 'name');
  }
  return value;
}

// 目标地址支持两种写法：以 / 开头的本机内置示例接口路径，以及完整的 http 或 https 地址
function validateUrl(url) {
  const value = pickText(url);
  if (!value) throw new ApiError(400, 'URL_REQUIRED', '目标地址不能为空', 'url');
  if (value.length > MAX_URL_LENGTH) {
    throw new ApiError(400, 'URL_TOO_LONG', `目标地址不能超过 ${MAX_URL_LENGTH} 个字符`, 'url');
  }
  if (value.startsWith('/')) {
    if (/\s/.test(value)) {
      throw new ApiError(400, 'URL_INVALID', '目标地址里不能出现空格，请检查是否有多余字符', 'url');
    }
    return value;
  }
  let parsed = null;
  try {
    parsed = new URL(value);
  } catch (err) {
    throw new ApiError(400, 'URL_INVALID', '目标地址需要以 http:// 或 https:// 开头，或填写 / 开头的内置示例接口路径', 'url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(400, 'URL_PROTOCOL_UNSUPPORTED', '目标地址只支持 http 与 https 两种协议', 'url');
  }
  return value;
}

// 请求头逐行校验：名称必填、字符合法、同名不重复
function validateHeaders(headers) {
  if (headers === undefined || headers === null) return [];
  if (!Array.isArray(headers)) {
    throw new ApiError(400, 'HEADERS_INVALID', '请求头需要按行列表填写', 'headers');
  }
  if (headers.length > MAX_HEADER_COUNT) {
    throw new ApiError(400, 'HEADERS_TOO_MANY', `请求头最多 ${MAX_HEADER_COUNT} 行`, 'headers');
  }
  const list = [];
  const seen = new Set();
  headers.forEach((row, index) => {
    const key = pickText(row && row.key);
    const value = typeof (row && row.value) === 'string' ? row.value : '';
    if (!key && !value) return; // 整行为空的直接跳过
    if (!key) {
      throw new ApiError(400, 'HEADER_KEY_REQUIRED', `第 ${index + 1} 行请求头缺少名称`, `headers.${index}.key`);
    }
    if (/[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(key)) {
      throw new ApiError(400, 'HEADER_KEY_INVALID', `请求头名称「${key}」含有非法字符`, `headers.${index}.key`);
    }
    const lower = key.toLowerCase();
    if (seen.has(lower)) {
      throw new ApiError(400, 'HEADER_KEY_DUPLICATE', `请求头「${key}」重复填写`, `headers.${index}.key`);
    }
    seen.add(lower);
    list.push({ key, value });
  });
  return list;
}

// 请求内容按请求方式与内容类型校验：GET 与 HEAD 不允许带内容，JSON 内容必须能解析
function validateBody(body, method, headers) {
  const value = typeof body === 'string' ? body : '';
  if (value.length > MAX_BODY_LENGTH) {
    throw new ApiError(400, 'BODY_TOO_LONG', `请求内容不能超过 ${MAX_BODY_LENGTH} 个字符`, 'body');
  }
  if (!value.trim()) return '';
  if (method === 'GET' || method === 'HEAD') {
    throw new ApiError(400, 'BODY_NOT_ALLOWED', `请求方式为 ${method} 时不支持填写请求内容`, 'body');
  }
  const contentType = headers.find((row) => row.key.toLowerCase() === 'content-type');
  const contentTypeValue = contentType ? contentType.value.toLowerCase() : '';
  if (contentTypeValue.includes('json')) {
    try {
      JSON.parse(value);
    } catch (err) {
      throw new ApiError(400, 'BODY_INVALID_JSON', `请求内容不是合法的 JSON：${err.message}`, 'body');
    }
  }
  return value;
}

// 读取用例列表，按创建时间从新到旧排列，顺序稳定
function listCases() {
  const data = load();
  return data.cases
    .slice()
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) return a.id < b.id ? 1 : -1;
      return a.createdAt < b.createdAt ? 1 : -1;
    });
}

function getCase(id) {
  const data = load();
  const found = data.cases.find((item) => item.id === id);
  if (!found) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  return found;
}

// 请求草稿的公共校验：保存用例与实际发送都走这一套，保证两边判断一致
function normalizeRequestDraft(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const method = validateMethod(input.method);
  const url = validateUrl(input.url);
  const headers = validateHeaders(input.headers);
  const body = validateBody(input.body, method, headers);
  return { method, url, headers, body };
}

function createCase(payload) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const name = validateName(input.name);
  const draft = normalizeRequestDraft(input);

  const data = load();
  const now = new Date().toISOString();
  const created = {
    id: crypto.randomUUID(),
    name,
    method: draft.method,
    url: draft.url,
    headers: draft.headers,
    body: draft.body,
    createdAt: now,
    updatedAt: now,
  };
  data.cases.push(created);
  save(data);
  return created;
}

function deleteCase(id) {
  const data = load();
  const index = data.cases.findIndex((item) => item.id === id);
  if (index === -1) throw new ApiError(404, 'CASE_NOT_FOUND', '用例不存在或已被删除', '');
  const [removed] = data.cases.splice(index, 1);
  save(data);
  return { id: removed.id, name: removed.name };
}

// 把常见失败状态码说成能直接看懂的结论
function describeFailedStatus(status, statusText) {
  const known = {
    400: '目标认为请求参数不合法，拒绝了这次请求',
    401: '目标要求先提供身份凭证',
    403: '身份凭证有效，但目标不允许访问',
    404: '目标地址对应的资源不存在',
    409: '目标认为这次请求与当前状态冲突',
    429: '请求过于频繁，被目标限流了',
    500: '目标服务内部处理失败',
    502: '目标的上游服务返回了异常',
    503: '目标服务暂时不可用',
    504: '目标等待上游响应超时',
  };
  const suffix = statusText ? `（${statusText}）` : '';
  return known[status] || `目标返回了失败状态码 ${status}${suffix}`;
}

// 每发送一次就落一条执行记录：记下目标地址、请求方式、结论、耗时与发生时刻
// 结论口径与结果区一致：拿到 400 以下状态算成功，网络层未完成或拿到 4xx/5xx 都算失败
function createExecution(draft, result, occurredAt) {
  const data = load();
  let outcome = 'success';
  let failureReason = '';
  let failureDetail = '';
  if (!result.ok) {
    outcome = 'failed';
    failureReason = (result.failure && result.failure.reason) || '这次请求没有成功完成';
    failureDetail = (result.failure && result.failure.detail) || '';
  } else if (result.status >= 400) {
    outcome = 'failed';
    failureReason = describeFailedStatus(result.status, result.statusText);
    failureDetail = `目标地址返回状态码 ${result.status}${result.statusText ? `（${result.statusText}）` : ''}`;
  }

  const record = {
    id: crypto.randomUUID(),
    method: draft.method,
    url: result.targetUrl || draft.url,
    internal: Boolean(result.internal),
    outcome,
    status: result.ok ? result.status : 0,
    timeMs: Number.isFinite(Number(result.timeMs)) ? Number(result.timeMs) : 0,
    failureReason,
    failureDetail,
    occurredAt: occurredAt || new Date().toISOString(),
  };
  data.executions.push(record);
  save(data);
  return record;
}

// 执行记录按发生时刻从新到旧排列；同一时刻用 id 兜底决胜，形成与筛选条件无关的全序
function listExecutions() {
  const data = load();
  return data.executions
    .slice()
    .sort((a, b) => {
      if (a.occurredAt === b.occurredAt) return a.id < b.id ? 1 : -1;
      return a.occurredAt < b.occurredAt ? 1 : -1;
    });
}

module.exports = {
  ApiError,
  ALLOWED_METHODS,
  normalizeRequestDraft,
  listCases,
  getCase,
  createCase,
  deleteCase,
  createExecution,
  listExecutions,
};
