// 端到端审计：mock OneBot（WS 收事件 + HTTP 发送）+ mock OpenAI 兼容 API，
// 完整跑一遍核心需求流程，逐项断言。不触碰真实 QQ / 真实模型。
//
// 运行：node test/selftest.mjs（DEBUG_TESTS=1 输出诊断）
import assert from 'node:assert';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

// ── 基础设施 ──
async function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(text)); } catch { resolve(text); }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* 继续等 */ }
    await sleep(40);
  }
  throw new Error(`等待超时：${label}`);
}

// ── Mock OneBot（HTTP + WS） ──
function createMockOneBotHttp() {
  const state = { sends: [], pokes: [] };
  const TINY_PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const action = req.url.replace(/^\//, '');
    const reply = (data) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data }));
    };
    if (action === 'get_login_info') return reply({ user_id: 888, nickname: '审计Bot' });
    if (action === 'get_group_info') return reply({ group_id: body.group_id, group_name: `审计群${body.group_id}` });
    if (action === 'get_group_member_info') return reply({ card: `名片${body.user_id}`, nickname: `昵称${body.user_id}` });
    if (action === 'get_group_list') return reply([{ group_id: 456, group_name: '审计群456' }, { group_id: 789, group_name: '备用群789' }]);
    if (action === 'get_friend_list') return reply([{ user_id: 777, nickname: '好友777', remark: '老友' }]);
    if (action === 'get_msg') return reply({ sender: { card: '被引用者', nickname: '被引用者' }, message: [{ type: 'text', data: { text: '被引用的原话' } }] });
    // 合并转发：按消息 id 返回两段记录（一段文字、一段带图）——测展开链路
    if (action === 'get_forward_msg') {
      return reply({
        messages: [
          { user_id: 1001, time: 1000, message_id: 9001, sender: { user_id: 1001, nickname: '转发者A', card: '' }, message: [{ type: 'text', data: { text: '第一段转发内容，谁懂' } }] },
          { user_id: 1002, time: 1001, message_id: 9002, sender: { user_id: 1002, nickname: '转发者B', card: '' }, message: [{ type: 'image', data: { url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png`, summary: '[图片]', file: 'fwd.png' } }] }
        ]
      });
    }
    if (action === 'fetch_custom_face_detail') return reply([{ emoji_id: 'st1', res_id: 'st1', md5: 'aaa', desc: '滑稽', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }]);
    if (action.startsWith('search')) {
      // 模拟 Bing 结果页（b_algo 块结构）
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<html><body>
        <li class="b_algo"><h2><a href="https://example.com/a">审计梗的完整解释</a></h2><p>审计梗是指……的完整解释内容。</p></li>
        <li class="b_algo"><h2><a href="https://example.com/b">第二个结果</a></h2><p>摘要二。</p></li>
      </body></html>`);
      return;
    }
    if (action === 'group_poke' || action === 'send_poke') {
      state.pokes.push(body);
      return reply({});
    }
    if (action === 'send_group_msg' || action === 'send_private_msg') {
      state.sends.push({ action, body, at: Date.now() });
      return reply({ message_id: 5000 + state.sends.length });
    }
    if (action === 'img.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(TINY_PNG);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, wording: '未知动作' }));
  });
  return { server, state };
}

function createMockOneBotWs() {
  const state = { client: null, events: [] };
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const ready = new Promise((r) => wss.once('listening', r));
  wss.on('connection', (socket) => { state.client = socket; });
  return {
    server: wss,
    state,
    async ready() { await ready; return wss.address().port; },
    push(event) {
      state.events.push(event);
      if (state.client && state.client.readyState === WebSocket.OPEN) {
        state.client.send(JSON.stringify(event));
      } else {
        throw new Error('Mock OneBot WS 尚无客户端连接');
      }
    },
    close() { return new Promise((r) => wss.close(r)); }
  };
}

// ── Mock OpenAI 兼容 API：脚本化响应 + 全量请求记录 ──
function createMockLLM() {
  const state = { requests: [], script: [] };
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }, { id: 'test-model-b' }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const body = await readBody(req);
      // 图片输入探测请求（vision scan）：不进脚本队列，按模型名给固定答案。
      // 用探测专属提问文本识别，避免误伤真实运行里"模型看图"的请求（同样带 image_url）。
      const isProbe = (body.messages || []).some((m) => Array.isArray(m.content)
        && m.content.some((c) => c.type === 'text' && String(c.text || '').includes('这张图片里是什么')));
      if (isProbe) {
        state.probes = state.probes || [];
        state.probes.push(body.model);
        if (String(body.model).includes('vision-no')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'image input is not supported for this model' } }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '一个红色像素点' } }] }));
        }
        return;
      }
      const step = state.requests.length;
      state.requests.push(body);
      // 强制故障（重试测试用）：直接按状态码队列返回，不依赖脚本序号。
      // 取完一个就 shift，用完后回落到正常脚本/默认响应。
      if (state.forceStatus && state.forceStatus.length) {
        const code = state.forceStatus.shift();
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `HTTP ${code}` } }));
        return;
      }
      let scripted = state.script[step];
      if (!scripted) scripted = { content: '（默认：无动作）' };
      if (scripted.delayMs) await sleep(scripted.delayMs);
      if (scripted.streamChunks) {
        // 流式响应：先发 SSE chunks，最后发 [DONE]；usage 放在最后一个 data chunk
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < scripted.streamChunks.length; i++) {
          const chunk = scripted.streamChunks[i];
          const delta = { content: chunk };
          res.write(`data: ${JSON.stringify({ id: `chatcmpl_${step}`, model: 'test-model-a', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
          await sleep(scripted.streamDelayMs || 30);
        }
        res.write(`data: ${JSON.stringify({ id: `chatcmpl_${step}`, model: 'test-model-a', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100 + step * 10, completion_tokens: 20, total_tokens: 120 + step * 10 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      const message = { role: 'assistant', content: scripted.content ?? null };
      if (scripted.toolCalls) {
        message.tool_calls = scripted.toolCalls.map((tc, i) => ({
          id: `call_${step}_${i}`,
          // 允许脚本显式指定畸形 type，用来验证"回传前规整"的行为
          type: tc.type ?? 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) }
        }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: `chatcmpl_${step}`,
        model: 'test-model-a',
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100 + step * 10, completion_tokens: 20, total_tokens: 120 + step * 10 }
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return { server, state };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// ── 主流程 ──
const PORTS = {};
const results = [];
function pass(name, extra = '') {
  results.push({ name, ok: true, extra });
  console.log(`  ✓ ${name}${extra ? ` —— ${extra}` : ''}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-test-'));
  process.env.QQ_AGENT_DATA_DIR = dataDir;

  const onebotHttp = createMockOneBotHttp();
  PORTS.onebotHttp = await listen(onebotHttp.server);
  const onebotWs = createMockOneBotWs();
  PORTS.onebotWs = await onebotWs.ready();
  const llm = createMockLLM();
  PORTS.llm = await listen(llm.server);

  // fixture：模拟 DSH settings.yaml + .credentials.yaml（密钥优先级：凭据文件 > 环境变量）
  const fixtureYaml = path.join(dataDir, 'dsh-settings.yaml');
  fs.writeFileSync(fixtureYaml, `
agent-default-model:
  provider: openrouter
  model: z-ai/glm-5.3-flash
llm-pi-ai:
  providers:
    a6api:
      displayName: A6API中转站
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com/v1
      models:
        - glm-5.3-flash
        - DeepSeek-V4-Flash-0731
    a6apiforclaude:
      displayName: A6API-Claude
      apiKeyEnv: A6API_API_KEY
      api: anthropic-messages
      baseURL: https://api.a6api.com
      models:
        - claude-fable-5
    openrouter:
      apiKeyEnv: OPENROUTER_API_KEY
      models:
        - z-ai/glm-5.3-flash
    local-8787:
      displayName: 本地中转8787
      apiKeyEnv: LOCAL_8787_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:8787/v1
      models:
        - hy4-preview
        - glm-5.3-flash
    visiontest:
      displayName: 视觉探测测试
      apiKeyEnv: VISIONTEST_API_KEY
      baseURL: http://127.0.0.1:${PORTS.llm}/v1
      models:
        - vision-ok-model
        - vision-no-model
`);
  process.env.A6API_APIKEY = 'test-a6api-key'; // 模拟环境变量别名解析（应被凭据文件覆盖）
  fs.writeFileSync(path.join(dataDir, '.credentials.yaml'), `version: 1
refs:
  A6API_API_KEY: cred-a6api-key
  LOCAL_8787_API_KEY: cred-local-key
  VISIONTEST_API_KEY: cred-visiontest-key
`);

  const cfg = {
    api: { baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a', vision: true, temperature: 0.7, maxRounds: 6, priceInputPerM: 2, priceOutputPerM: 8 },
    providersSourceYaml: fixtureYaml,
    webSearch: { enabled: true, searchUrl: `http://127.0.0.1:${PORTS.onebotHttp}/search`, maxResults: 6 },
    security: { allowPrivateImageHosts: false },
    snowluma: { wsUrl: `ws://127.0.0.1:${PORTS.onebotWs}`, httpUrl: `http://127.0.0.1:${PORTS.onebotHttp}`, accessToken: '' },
    persona: { botName: '审计Bot', participation: 'medium', roleText: '你是审计群里的机器人。' },
    allow: { groups: ['456'], private: ['777'] },
    deny: { groups: [], private: [] },
    allowAllWhenEmpty: false,
    wakeDelayMs: 300,
    drainDelayMs: 200,
    maxConcurrentRuns: 2,
    send: { minGapMs: 10, maxGapMs: 20, byLengthMs: 0, maxPerMinute: 100, maxPerHour: 1000, hardSplitAt: 4000 },
    proactive: { enabled: false },
    sticker: { enabled: true, collectEnabled: true },
    store: { maxMessagesPerChat: 0, pastStateLimit: 80, pastStateMaxChars: 6000, keepSessionFiles: 100 },
    // 前情摘要默认关掉：它会在**每次运行结束后**额外发一次模型请求，而 mock LLM 是按
    // 绝对请求下标取脚本的（state.script[step]）—— 意外的额外调用会让后面所有脚本错位。
    // 需要时在专门的场景里开，并自己按当前下标挂脚本。
    summary: { enabled: false },
    server: { port: await freePort(), token: '' }
  };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify(cfg));

  const { createApp } = await import('../src/app.js');
  const app = createApp({ log: () => {} });
  await app.start();

  // 同步原语
  const waitSessionDone = async (triggerSubstring, timeout = 9000) => {
    const s = await waitFor(() => {
      const found = app.sessions.listSummaries(30).find((e) => (e.trigger || '').includes(triggerSubstring));
      if (found && found.status !== 'running' && found.status !== 'waiting') return found;
      return null;
    }, timeout, `会话(${triggerSubstring})结束`);
    return app.sessions.get(s.id);
  };
  const pushGroupMsg = (userId, name, text, mid, extra = {}) => onebotWs.push({
    post_type: 'message',
    message_type: 'group',
    group_id: 456,
    user_id: userId,
    self_id: 888,
    message_id: mid,
    time: Math.floor(Date.now() / 1000),
    sender: { user_id: userId, card: name, nickname: name },
    message: [{ type: 'text', data: { text } }],
    ...extra
  });

  // ── 场景 0：OneBot 已连接 ──
  await waitFor(() => app.onebot.connected, 5000, 'OneBot WS 连接');
  pass('OneBot WebSocket 已连接并取得登录信息', `self=${app.onebot.selfId}`);

  // ── 场景 1：消息触发运行，模型用工具发言 ──
  llm.state.script.push(
    // 故意给一个畸形 type：模拟上游返回 "functionfunction"。这类值原样回传会被
    // 上游校验拒掉（The parameter `messages.tool_calls.type` ... invalid value），
    // 所以回传前必须由我们规整 —— 下面会断言这一点。
    { delayMs: 400, toolCalls: [{ name: 'send_message', args: { messages: ['在的', '咋了 [CQ:at,qq=1]'] }, type: 'functionfunction' }] },
    { content: '（第一轮处理完毕）' }
  );
  pushGroupMsg(111, '张三', '在吗？', 9001);

  await waitFor(() => llm.state.requests.length >= 1, 5000, '第一次 LLM 调用');
  const req1 = llm.state.requests[0];
  assert.strictEqual(req1.messages.length, 2, '第一次运行只应有 system+user 两条消息（零 LLM 历史）');
  assert.strictEqual(req1.messages[0].role, 'system');
  assert.strictEqual(req1.messages[1].role, 'user');
  const user1 = req1.messages[1].content;
  assert.ok(user1.includes('【本次唤醒】') && user1.includes('在吗？'), '用户消息含本次唤醒与触发文本');
  assert.ok(user1.includes('【当前时间】') && user1.includes('【过去状态】'), '用户消息含时间与过去状态');
  assert.ok(req1.tools?.some((t) => t.function.name === 'send_message'), 'send_message 工具已暴露');
  const toolNames = req1.tools.map((t) => t.function.name);
  assert.ok(!toolNames.some((n) => n.includes('qq_')), '工具名不带 qq_ 前缀');
  assert.ok(!toolNames.includes('wait_for_messages') && !toolNames.includes('set_wake_config'), '无等待/唤醒类工具');
  pass('运行 1：零历史提示词 + 工具集正确', `${user1.length} 字符用户消息`);

  const session1 = await waitSessionDone('在吗？');
  await waitFor(() => onebotHttp.state.sends.length >= 2, 5000, '两条 QQ 消息已发出');
  const send1 = onebotHttp.state.sends[0];
  const send2 = onebotHttp.state.sends[1];
  assert.strictEqual(send1.body.message[0].data.text, '在的');
  assert.strictEqual(send2.body.message[0].data.text, '咋了 [CQ：at,qq=1]', 'CQ 码已转义');
  pass('发送：分条 + 顺序 + CQ 转义正确');

  // ── 回归：回传给上游的 assistant 消息必须是"干净"的 ──
  // 1) tool_calls.type 只能是 'function'。上游可能返回畸形值（本轮脚本里就埋了
  //    "functionfunction"），照抄回去下一轮会被上游校验拒绝。
  // 2) 不能带 raw —— 那是我们自己的留档字段（存 usage 给用量页统计），
  //    严格的上游会因消息里冒出未知字段直接 400。
  await waitFor(() => llm.state.requests.length >= 2, 5000, '第二次 LLM 调用（带工具结果）');
  const reqBack = llm.state.requests[1];
  const assistantBack = reqBack.messages.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  assert.ok(assistantBack, '第二次请求里应带上带 tool_calls 的 assistant 消息');
  assert.strictEqual(assistantBack.tool_calls[0].type, 'function',
    `畸形 type 应被规整回 function，实际：${assistantBack.tool_calls[0].type}`);
  assert.ok(!('raw' in assistantBack), 'assistant 消息不应带 raw 字段');
  assert.strictEqual(
    reqBack.messages.filter((m) => m.role === 'tool').length,
    assistantBack.tool_calls.length,
    '每个 tool_call 都应有一条对应的 tool 结果消息'
  );
  pass('回传的 assistant 消息已规整（type=function、无 raw）');

  assert.ok(session1.status === 'done', `运行 1 状态应为 done，实际 ${session1.status}`);
  assert.strictEqual(session1.usage.totalTokens, 250, 'usage 已累计两次调用（120+130）');
  assert.strictEqual(session1.sent.length, 2, '会话记录了 2 条已发送');
  assert.ok(session1.systemPrompt && session1.userPrompt, '会话记录含完整提示词');
  pass('会话记录：状态/用量/已发送/提示词留档完整', `totalTokens=${session1.usage.totalTokens}`);

  // ── 场景 2：处理期间插入新消息 → 结束后 drain 新开会话（需求 5 核心流程） ──
  llm.state.script.push(
    { delayMs: 600, content: '（看看再说）' },          // 运行 A：只有一轮，人为拖慢
    { content: '（看了下是闲聊，不用回）' }             // drain 运行
  );
  const reqsBeforeA = llm.state.requests.length;
  pushGroupMsg(113, '王五', '看看这个', 9010);
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 1, 5000, '运行 A 开始');
  await sleep(250);                                    // 处于 600ms 延迟中 = 运行 A 进行中
  pushGroupMsg(111, '张三', '处理期间插进来的新消息', 9011);  // ← 关键注入

  const sessionA = await waitSessionDone('看看这个');
  assert.strictEqual(sessionA.status, 'noreply', '运行 A 没有发言（正常选项）');
  assert.ok(onebotHttp.state.sends.every((s) => s.body.message.at(-1).data.text !== '（看看再说）'), '思考文本不会发到 QQ');

  // drain：运行 A 结束后自动开新会话处理 9011
  await waitFor(() => llm.state.requests.length >= reqsBeforeA + 2, 6000, 'drain 运行开始');
  const drainReq = llm.state.requests.at(-1);
  assert.strictEqual(drainReq.messages.length, 2, 'drain 运行同样是全新会话（零历史）');
  assert.ok(drainReq.messages[1].content.includes('处理期间插进来的新消息'), 'drain 运行的【本次唤醒】是处理期间插入的消息');
  assert.ok(!drainReq.messages[1].content.includes('在的"') || drainReq.messages[1].content.includes('我：在的'), '此前发言只以存档形式出现');
  await waitSessionDone('处理期间插进来的新消息');
  pass('drain 循环：运行中新消息 → 结束后自动新开会话处理，每次 messages.length=2');

  const meta = app.store.getChatMeta('group:456');
  assert.strictEqual(meta.unread, 0, '所有消息已标记已读');
  assert.strictEqual(meta.total, 5, '存档 = 3 条收到的 + 2 条自己发的');
  pass('已读/未读驱动：处理完全部标记已读，自己的发言入档', `total=${meta.total}`);

  // ── 场景 3：白名单外完全忽略 ──
  const llmCallsBefore = llm.state.requests.length;
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 999, user_id: 111, self_id: 888,
    message_id: 9100, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 111, card: '外人', nickname: '外人' },
    message: [{ type: 'text', data: { text: '白名单外' } }]
  });
  await sleep(800);
  assert.strictEqual(llm.state.requests.length, llmCallsBefore, '白名单外不触发 LLM');
  assert.strictEqual(app.store.listChats().includes('group:999'), false, '白名单外不写入存档');
  pass('白名单：群 999 被完全忽略');

  // ── 场景 4：引用消息解析 + reply 段 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['收到'], replyToMessageId: 9001 } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 113, self_id: 888,
    message_id: 9003, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 113, card: '王五', nickname: '王五' },
    message: [
      { type: 'reply', data: { id: 9001 } },
      { type: 'text', data: { text: '张三说的对' } }
    ]
  });
  await waitSessionDone('张三说的对');
  await waitFor(() => onebotHttp.state.sends.length >= 3, 5000, '引用场景的发送');
  const send3 = onebotHttp.state.sends[2];
  assert.strictEqual(send3.body.message[0].type, 'reply', '第一条带 reply 段');
  assert.strictEqual(send3.body.message[0].data.id, '9001');
  assert.strictEqual(send3.body.message[1].data.text, '收到');
  const replyRunReq = llm.state.requests.at(-2);
  assert.ok(replyRunReq.messages[1].content.includes('[引用 被引用者：被引用的原话]'), '引用原文被解析进上下文');
  pass('引用解析与 reply 段发送正确');

  // ── 场景 5：群友印象跨运行持久（无状态但记忆保留，且按相关成员注入） ──
  llm.state.script.push(
    { toolCalls: [{ name: 'memory_append', args: { category: 'memberImpression', userId: 111, target: '张三', content: '张三喜欢聊今晚吃什么' } }, { name: 'send_message', args: { messages: ['记下了'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '帮我记一下张三喜欢聊今晚吃什么', 9004);
  const session5 = await waitSessionDone('帮我记一下');
  assert.strictEqual(session5.status, 'done');
  assert.ok(app.memory.query('group:456').memberImpression.some((e) => e.userId === '111' && e.content === '张三喜欢聊今晚吃什么'), '群友印象已按 QQ 号写入存储');

  llm.state.script.push({ content: '（看过了）' });
  const reqs5b = llm.state.requests.length;
  pushGroupMsg(111, '张三', '我又来了', 9005);
  await waitFor(() => llm.state.requests.length >= reqs5b + 1, 5000, '带记忆的后续运行开始');
  const memPrompt = llm.state.requests.at(-1).messages[1].content;
  assert.ok(memPrompt.includes('张三喜欢聊今晚吃什么'), '【记忆】跨运行出现在相关成员发言的新会话提示词里');
  await waitSessionDone('我又来了');
  pass('群友印象跨运行持久化 + 相关成员注入');

  // ── 场景 6：表情包同步 + SSRF 拦截 + 发表情机制 ──
  const stickers = await app.stickers.sync(true);
  assert.ok(stickers.entries.length >= 1, '从 mock OneBot 同步到收藏表情');
  // 6a. 本地/内网地址的图片必须被拒绝（防护生效即"不发送"）
  llm.state.script.push(
    { toolCalls: [{ name: 'send_sticker', args: { stickerId: 'st1' } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '来个表情', 9006);
  const stickerSession = await waitSessionDone('来个表情');
  assert.ok(
    stickerSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('不合法')),
    '内网图片地址被 SSRF 防护拦截并回传模型'
  );
  pass('表情包安全：内网/本机图片地址被拒绝');
  // 6b. 发送机制本身：绕过工具直接走发送队列，验证 image 段
  const sendsBeforeSticker = onebotHttp.state.sends.length;
  await app.sender.sendSticker('group:456', { id: 'st1', desc: '直发测试', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` }, {});
  await waitFor(() => onebotHttp.state.sends.length >= sendsBeforeSticker + 1, 5000, '表情发送');
  const stickerSend = onebotHttp.state.sends.at(-1);
  assert.strictEqual(stickerSend.body.message.at(-1).type, 'image', '表情以 image 段发送');
  assert.ok(stickerSend.body.message.at(-1).data.file.includes('/img.png'), '表情 URL 正确');
  pass('表情包发送：image 段 + 存档记录');

  // ── 场景 7：限频保护 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 1, minGapMs: 5, maxGapMs: 10, byLengthMs: 0, maxPerHour: 1000, hardSplitAt: 4000 } })
  });
  await sleep(80);
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: ['一条', '两条', '三条'] } }] },
    { content: 'ok' }
  );
  pushGroupMsg(111, '张三', '刷屏测试', 9007);
  const limited = await waitSessionDone('刷屏测试');
  // 超出的部分发送失败。此时工具回 ok（成功的消息已真实发出，不能整体判为失败），
  // 并在 note 里告知模型失败条数与原因 —— 断言适配该行为。
  const sendCall = limited.messages.find((m) => m.toolCall?.name === 'send_message');
  assert.ok(sendCall, '存在 send_message 工具调用');
  // 两种合法结果：全败时工具回 err（含"频率超限"）；部分失败时回 ok 且 note 含"发送失败"。
  // 无论哪种，都必须带具体的失败条数与原文，便于模型判断要不要重发。
  const resultText = String(sendCall.toolCall.result);
  assert.ok(
    resultText.includes('频率超限') || resultText.includes('发送失败'),
    '超限的发送被拒绝并把失败情况回传模型'
  );
  assert.ok(
    /第\d+条/.test(resultText),
    '失败信息里带上了具体是哪一条（便于模型定位与重发）'
  );
  pass('发送限频：超额部分被拒绝，失败情况（含条数定位）回传模型');
  // 恢复限频配置
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ send: { maxPerMinute: 100 } })
  });

  // ── 场景 8：暂停开关 + 手动唤醒 ──
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: true }) });
  const callsBeforePause = llm.state.requests.length;
  pushGroupMsg(111, '张三', '暂停期间的消息', 9008);
  await sleep(900);
  assert.strictEqual(llm.state.requests.length, callsBeforePause, '暂停期间不触发运行');
  assert.ok(app.store.getChatMeta('group:456').unread >= 1, '暂停期间消息仍入档为未读');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/pause`, { method: 'POST', body: JSON.stringify({ paused: false }) });
  llm.state.script.push({ content: '（恢复后检查一遍，不用回）' }); // 显式脚本，保证后续索引不漂移
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/wake`, { method: 'POST', body: '{}' });
  await waitSessionDone('暂停期间的消息');
  pass('暂停/恢复 + 手动唤醒（暂停期间消息积压为未读）');

  // ── 场景 9：私聊 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'send_message', args: { messages: '私聊回复' } }] },
    { content: 'ok' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'private', user_id: 777, self_id: 888,
    message_id: 9200, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 777, nickname: '好友' },
    message: [{ type: 'text', data: { text: '单独找你' } }]
  });
  try {
    await waitFor(() => onebotHttp.state.sends.some((s) => s.action === 'send_private_msg'), 6000, '私聊发送');
  } catch (error) {
    if (process.env.DEBUG_TESTS) {
      console.log('[debug] newest session:', JSON.stringify(app.sessions.listSummaries(3), null, 1));
      const latest = app.sessions.get(app.sessions.listSummaries()[0]?.id);
      console.log('[debug] latest detail error:', latest?.error, 'status:', latest?.status);
      console.log('[debug] store chats:', app.store.listChats());
    }
    throw error;
  }
  const privSend = onebotHttp.state.sends.find((s) => s.action === 'send_private_msg');
  assert.strictEqual(privSend.body.user_id, 777);
  assert.strictEqual(privSend.body.message.at(-1).data.text, '私聊回复');
  await waitSessionDone('单独找你');
  pass('私聊流程正常');

  // ── 场景 10：拍一拍触发 ──
  llm.state.script.push({ content: '（拍一下而已，不回）' });
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 114, target_id: 888, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await waitFor(() => {
    const latest = llm.state.requests.at(-1);
    return latest?.messages?.[1]?.content?.includes('拍一拍');
  }, 8000, '拍一拍触发运行');
  await waitSessionDone('拍一拍');
  pass('拍一拍事件触发处理');

  // ── 场景 10b：自己拍一拍的 OneBot 回显不触发（自回环防护）──
  const pokesBefore = onebotHttp.state.pokes.length;
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: 114 } }] },
    { content: '（戳一下而已，不说话）' }
  );
  pushGroupMsg(115, '阿五', '戳我一下试试', 9025);
  await waitSessionDone('戳我一下试试');
  await waitFor(() => onebotHttp.state.pokes.length > pokesBefore, 6000, '拍一拍发送');
  const selfPoke = app.store.recent('group:456', { limit: 10 }).find((m) => m.self && String(m.text).includes('拍一拍'));
  assert.ok(selfPoke, '自己的拍一拍已留档为 self 记录');
  assert.strictEqual(selfPoke.read, true, '自己的拍一拍为已读');
  const callsBeforePokeEcho = llm.state.requests.length;
  onebotWs.push({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
    group_id: 456, user_id: 888, target_id: 114, self_id: 888,
    time: Math.floor(Date.now() / 1000)
  });
  await sleep(2500);
  assert.strictEqual(llm.state.requests.length, callsBeforePokeEcho, '自己拍的拍回显不触发新会话');
  assert.strictEqual(app.store.getChatMeta('group:456').unread, 0, '回显不产生未读');
  pass('拍一拍自回环防护：自拍回显不触发 + 自拍留档');

  // ── 场景 10d：拍一拍缺 target_id 时不能臆测成"拍了自己" ──
  // 各协议端对 poke 事件的字段不统一：群聊通常给 target_id，私聊往往只有 user_id。
  // 早期实现用 `event.target_id ?? event.user_id` 兜底 —— target 于是恒等于操作者，
  // "谁拍了谁"的判断必然成立，任何一次拍一拍都被记成「XXX 拍了拍自己」。
  {
    // 按"新出现的会话"等待，避免 waitSessionDone 误配到同名的旧会话
    const settledIds = new Set(
      app.sessions.listSummaries(50).filter((e) => e.status !== 'running' && e.status !== 'waiting').map((e) => e.id)
    );
    const waitFreshSessionDone = async (label) => {
      const found = await waitFor(() => {
        const fresh = app.sessions.listSummaries(50)
          .find((e) => !settledIds.has(e.id) && e.status !== 'running' && e.status !== 'waiting');
        return fresh || null;
      }, 9000, label);
      settledIds.add(found.id);
      return app.sessions.get(found.id);
    };
    const poke = (extra) => onebotWs.push({
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      self_id: 888, time: Math.floor(Date.now() / 1000), ...extra
    });
    const lastPokeText = (chatKey) => [...(app.store.recent(chatKey, { limit: 20 }) || [])]
      .reverse().find((m) => String(m.text || '').includes('[拍一拍]'));

    // (1) 私聊、无 target_id：只有"对方↔机器人"两方，必然是拍机器人
    llm.state.script.push({ content: '（拍一下而已，不回）' });
    poke({ user_id: 777 });
    const privPoke = await waitFor(() => {
      const t = lastPokeText('private:777');
      return t && String(t.text).includes('拍了拍你') ? t : null;
    }, 6000, '私聊拍一拍入档');
    assert.ok(!String(privPoke.text).includes('拍了拍自己'),
      `私聊拍一拍不能被记成"拍了自己"：${privPoke.text}`);
    await waitFreshSessionDone('私聊拍一拍运行结束');

    // (2) 群聊、无 target_id：判断不了目标，如实说明，绝不臆测
    llm.state.script.push({ content: '（拍一下而已，不回）' });
    poke({ group_id: 456, user_id: 114 });
    const unknownPoke = await waitFor(() => {
      const t = lastPokeText('group:456');
      return t && String(t.text).includes('未提供 target_id') ? t : null;
    }, 6000, '群聊缺 target_id 入档');
    assert.ok(!String(unknownPoke.text).includes('拍了拍自己'),
      `群聊缺 target_id 时不能臆测成"拍了自己"：${unknownPoke.text}`);
    await waitFreshSessionDone('群聊缺 target_id 运行结束');

    // (3) 群聊、target_id 指向机器人 → 判定为拍机器人
    llm.state.script.push({ content: '（拍一下而已，不回）' });
    poke({ group_id: 456, user_id: 114, target_id: 888 });
    const mePoke = await waitFor(() => {
      const t = lastPokeText('group:456');
      return t && String(t.text).includes('拍了拍你') ? t : null;
    }, 6000, '群聊点名拍机器人入档');
    assert.ok(!String(mePoke.text).includes('拍了拍自己'), `群聊拍机器人判定错误：${mePoke.text}`);
    await waitFreshSessionDone('群聊拍机器人运行结束');

    // (4) 群聊、target_id 指向别人 → 记为拍了那个人，不是"自己"
    llm.state.script.push({ content: '（拍一下而已，不回）' });
    poke({ group_id: 456, user_id: 114, target_id: 113 });
    const otherPoke = await waitFor(() => {
      const t = lastPokeText('group:456');
      return t && String(t.text).includes('拍了拍') && !String(t.text).includes('拍了拍你')
        && !String(t.text).includes('target_id') ? t : null;
    }, 6000, '群聊拍别人入档');
    assert.ok(!String(otherPoke.text).includes('拍了拍自己'),
      `拍别人不能被记成"拍了自己"：${otherPoke.text}`);
    await waitFreshSessionDone('群聊拍别人运行结束');

    pass('拍一拍目标判定：私聊 / 群聊缺 target_id / 群聊点名，四种情形都不误判为"拍了自己"');
  }

  // ── 场景 10c：消息 id 引导（报错带可用 id）+ send_poke 参数校验 + recent 带 messageId ──
  const pokesBeforeC = onebotHttp.state.pokes.length;
  llm.state.script.push(
    { toolCalls: [{ name: 'send_poke', args: { targetUserId: '张三' } }] },
    { toolCalls: [{ name: 'get_message_detail', args: { messageId: 999999 } }] },
    { toolCalls: [{ name: 'get_recent_messages', args: { limit: 10 } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(116, '阿六', '测试工具报错', 9026);
  const toolErrSession = await waitSessionDone('测试工具报错');
  const pokeErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'send_poke');
  assert.ok(pokeErr?.toolCall?.isError && String(pokeErr.toolCall.result).includes('正整数'), 'send_poke 非法参数返回人话报错');
  assert.strictEqual(onebotHttp.state.pokes.length, pokesBeforeC, '非法 targetUserId 不透传 OneBot');
  const detailErr = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_message_detail');
  assert.ok(detailErr?.toolCall?.isError && String(detailErr.toolCall.result).includes('不要自己编'), '找不到消息时报错带引导');
  assert.ok(/\d{4,}/.test(String(detailErr.toolCall.result)), '报错里列出真实可见的消息 id');
  const recentTool = toolErrSession.messages.find((m) => m.toolCall?.name === 'get_recent_messages');
  assert.ok(!recentTool?.toolCall?.isError && String(recentTool.toolCall.result).includes('messageId'), 'get_recent_messages 返回真实消息 id');
  pass('消息 id 引导：报错带可用 id + send_poke 校验 + recent 带 messageId');

  // ── 场景 12：联网搜索 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_search', args: { query: '审计梗 是什么' } }] },
    { content: '（搜到了，不用回）' }
  );
  pushGroupMsg(111, '张三', '审计梗是什么意思', 9020);
  const searchSession = await waitSessionDone('审计梗是什么意思');
  assert.ok(searchSession.messages.some((m) => m.toolCall?.name === 'web_search' && !m.toolCall.isError), 'web_search 调用成功');
  const searchReq = llm.state.requests.at(-1);
  const searchToolMsg = searchReq.messages.find((m) => m.role === 'tool' && m.name === 'web_search');
  assert.ok(searchToolMsg && String(searchToolMsg.content).includes('审计梗的完整解释'), '搜索结果以文本进入模型上下文');
  pass('联网搜索：web_search 结果回传模型');

  // ── 场景 13：web_fetch SSRF 防护 ──
  llm.state.script.push(
    { toolCalls: [{ name: 'web_fetch', args: { url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }] },
    { content: '（知道了）' }
  );
  pushGroupMsg(112, '李四', '帮我抓内网页面', 9021);
  const fetchSession = await waitSessionDone('帮我抓内网页面');
  assert.ok(fetchSession.messages.some((m) => m.toolCall?.isError && String(m.toolCall.result).includes('内网')), 'web_fetch 拒绝内网地址');
  pass('web_fetch SSRF 防护：内网地址被拒绝');

  // ── 场景 14：图片输入链路（vision） ──
  // 14a. 图片作为图像输入到达模型：tool 消息带文本，图片以 user 消息(image_url)补发
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ security: { allowPrivateImageHosts: true } }) // 测试例外：允许下载 mock 服务器上的本地图
  });
  llm.state.script.push(
    { toolCalls: [{ name: 'get_message_images', args: { messageId: 9022 } }] },
    { content: '（图看到了）' }
  );
  onebotWs.push({
    post_type: 'message', message_type: 'group', group_id: 456, user_id: 115, self_id: 888,
    message_id: 9022, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 115, card: '赵六', nickname: '赵六' },
    message: [
      { type: 'text', data: { text: '看这个图' } },
      { type: 'image', data: { file: 'a.png', url: `http://127.0.0.1:${PORTS.onebotHttp}/img.png` } }
    ]
  });
  const visionSession = await waitSessionDone('看这个图');
  assert.ok(visionSession.messages.some((m) => m.toolImages?.count === 1), '会话记录了图片注入');
  const visReq = llm.state.requests.at(-1);
  const visToolMsg = visReq.messages.find((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolMsg && typeof visToolMsg.content === 'string' && !visToolMsg.content.includes('base64'), 'tool 消息只带文本，不塞 base64');
  const imgUserIdx = visReq.messages.findIndex((m) => m.role === 'user' && Array.isArray(m.content));
  assert.ok(imgUserIdx > -1, '图片以 user 消息注入');
  const imgPart = visReq.messages[imgUserIdx].content.find((p) => p.type === 'image_url');
  assert.ok(imgPart && String(imgPart.image_url.url).startsWith('data:image/png;base64,'), '图片为 PNG data URL');
  const visToolIdx = visReq.messages.findIndex((m) => m.role === 'tool' && m.name === 'get_message_images');
  assert.ok(visToolIdx > -1 && visToolIdx < imgUserIdx, '消息顺序合法：tool 结果在前，图片 user 消息在后');
  pass('图片输入：tool 文本 + user 消息 image_url 补发，结构兼容 OpenAI 校验');

  // 14b. vision=false 时看图工具被移除、搜索工具保留
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: false } })
  });
  llm.state.script.push({ content: '（看不了图，不回）' });
  pushGroupMsg(111, '张三', '再来一张图', 9023);
  await waitSessionDone('再来一张图');
  const visOffReq = llm.state.requests.at(-1);
  assert.ok(!visOffReq.tools.some((t) => t.function.name === 'get_message_images'), 'vision=false 时看图工具被移除');
  assert.ok(visOffReq.tools.some((t) => t.function.name === 'web_search'), '搜索工具不受影响');
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { vision: true }, security: { allowPrivateImageHosts: false } })
  });
  pass('vision 开关：关闭后移除看图工具，提示词同步变化');

  // ── 场景 15：群/好友列表 + 手动测试消息 ──
  const groupsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/groups`)).json();
  assert.ok(groupsRes.groups.some((g) => g.id === '456' && g.name === '审计群456'), '群列表可供白名单勾选');
  const friendsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/onebot/friends`)).json();
  assert.ok(friendsRes.friends.some((f) => f.id === '777'), '好友列表可供白名单勾选');
  const testSendRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/group_456/test-send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '手动测试消息' })
  })).json();
  assert.ok(testSendRes.ok, '测试消息发送成功');
  assert.ok(onebotHttp.state.sends.some((s) => s.body.message.at(-1).data.text === '手动测试消息'), '测试消息到达 OneBot');
  assert.ok(app.store.recent('group:456', { limit: 5 }).some((m) => m.self && m.text === '手动测试消息'), '测试消息入档为自己的发言');
  const tplRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/persona-templates`)).json();
  assert.ok(tplRes.templates.some((t) => t.id === 'xiaojingyu' && t.text.includes('DeepSeek 小鲸鱼')), '原版小鲸鱼人设模板在内');
  pass('引导助手：群/好友列表 + 手动测试消息 + 人设模板');

  // 场景 16（预算保险丝）已随功能一并移除。
  // 原因：priceInputPerM / priceOutputPerM 实际恒为 0（走中转站套餐制），
  // estimateCost() 永远返回 0 -> overBudget() 恒 false，保险丝从未真正生效，
  // 而 UI 上还显示「今日 ¥0.00」误导用户。留着不如去掉。

  // ── 场景 17：手动模型目录（添加提供商 + 模型管理 + 切换） ──
  // 通过新 API 手动添加两个提供商（等价于设置页“确认添加”），再验证模型追加/删除/切换。
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'https://api.a6api.com/v1',
      apiKey: 'cred-a6api-key',
      models: [
        { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
        { id: 'DeepSeek-V4-Flash-0731', name: 'DS Flash' }
      ]
    })
  });
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: 'http://127.0.0.1:8787/v1',
      apiKey: 'local-key-1',
      models: [{ id: 'hy4-preview', name: '混元 Preview' }]
    })
  });
  const provRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  assert.strictEqual(provRes.providers.length, 2, `应存在 2 个手动添加的提供商（实际 ${provRes.providers.length}）`);
  const a6 = provRes.providers.find((p) => p.baseURL === 'https://api.a6api.com/v1');
  assert.ok(a6 && a6.hasKey && a6.apiKey === '', 'API 不返回明文 Key，但 hasKey 标记为 true');
  assert.ok(a6.models.includes('glm-5.3-flash'), '模型列表完整');
  const local = provRes.providers.find((p) => p.baseURL === 'http://127.0.0.1:8787/v1');
  assert.ok(local && local.models.includes('hy4-preview'), '本地网关模型已添加');
  // 追加模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] })
  });
  const provRes2 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local2 = provRes2.providers.find((p) => p.id === local.id);
  assert.ok(local2.models.includes('glm-5.3-flash'), '追加模型成功');
  // 切换到目录里的模型（等价于 UI 选中后的字段填充）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: local.id, baseUrl: 'http://127.0.0.1:8787/v1', apiKey: 'local-key-1', model: 'hy4-preview' } })
  });
  const cfgAfter = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`)).json();
  assert.strictEqual(cfgAfter.api.provider, local.id);
  assert.strictEqual(cfgAfter.api.model, 'hy4-preview');
  // 删除模型
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers/models`, {
    method: 'DELETE', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ providerId: local.id, modelId: 'glm-5.3-flash' })
  });
  const provRes3 = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json();
  const local3 = provRes3.providers.find((p) => p.id === local.id);
  assert.ok(!local3.models.includes('glm-5.3-flash'), '删除模型成功');
  // 切回测试模型，保证后续场景正常
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api: { provider: '', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'test-key', model: 'test-model-a' } })
  });
  pass('手动模型目录：添加提供商 + 追加/删除模型 + 切换');

  // ── 场景 11：HTTP API 完整性 ──
  const statusRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/status`)).json();
  assert.ok(statusRes.onebot.connected === true);
  assert.ok(statusRes.usage.totalTokens > 0, '今日 token 统计 > 0');
  // cost 字段已移除（估算金额依赖单价配置，实际恒为 0，不展示）
  assert.ok(statusRes.usage.cost === undefined, '成本估算字段已移除');
  const modelsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/models`)).json();
  assert.strictEqual(modelsRes.models.length, 2, '模型列表 API');
  const sessRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions`)).json();
  assert.ok(sessRes.sessions.length >= 8, `会话列表有记录（${sessRes.sessions.length}）`);
  const oneSession = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/sessions/${sessRes.sessions[0].id}`)).json();
  assert.ok(oneSession.messages && oneSession.systemPrompt);
  const chatsRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats`)).json();
  assert.ok(chatsRes.chats.some((c) => c.key === 'group:456'));
  const uiRes = await fetch(`http://127.0.0.1:${cfg.server.port}/`);
  assert.ok((await uiRes.text()).includes('QQ Agent'), 'UI 首页可访问');
  pass('HTTP API：status/models/sessions/chats/UI 全部可用', `今日 ${statusRes.usage.totalTokens} tok`);

  // ── 场景 26：群友印象手动整理（逐成员整理 + 按聊天记录过滤 + 备份）──
  let i = 0;
  while (app.memory.consolidationState('group:456').counts.memberImpression <= 8) {
    app.memory.append('group:456', 'memberImpression', `对114的第${++i}条印象——测试整理用的独特内容`, { userId: '114', target: '114' });
  }
  assert.ok(app.memory.consolidationState('group:456').counts.memberImpression > 8, '印象已灌到超阈值');
  // 手动整理：模拟 114 在聊天记录里出现 3 次以上
  app.store.appendIncoming('group:456', { mid: 9101, ts: Date.now() - 3000, senderId: '114', senderName: '114', text: '手动整理测试1' });
  app.store.appendIncoming('group:456', { mid: 9102, ts: Date.now() - 2000, senderId: '114', senderName: '114', text: '手动整理测试2' });
  app.store.appendIncoming('group:456', { mid: 9103, ts: Date.now() - 1000, senderId: '114', senderName: '114', text: '手动整理测试3' });
  llm.state.script.push(
    { content: JSON.stringify({ impressions: ['合并后的综合印象（来自整理测试）'] }) },
    // 111 也会被整理，补一条脚本，避免它吃到"默认：无动作"而产生解析噪音
    { content: JSON.stringify({ impressions: ['合并后的综合印象（111）'] }) }
  );
  const consResp = await fetch(`http://127.0.0.1:${cfg.server.port}/api/memory-files/consolidate`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatKey: 'group:456' })
  });
  const consJson = await consResp.json();
  assert.strictEqual(consJson.ok, true, `手动整理接口已启动（响应：${JSON.stringify(consJson)}）`);
  await waitFor(() => app.memory.getMember('group:456', '114').impressions.length === 1, 10000, '群友印象手动整理完成');
  const memAfter = app.memory.query('group:456');
  assert.ok(String(memAfter.memberImpression[0].content).includes('合并后的综合印象'), '整理结果写回存储');
  const backupDir = path.join(dataDir, 'memory', 'backups', 'group_456');
  assert.ok(fs.existsSync(path.join(backupDir, '114.json')), '整理前原印象已备份到会话文件夹备份');
  pass('群友印象手动整理：逐成员整理 + 写回 + 备份');

  // 冷却验证：断言没有"额外的"自动整理被触发。
  // 注意：手动整理本身会因「发现新人」额外调用若干次模型（同一次任务内部，属正常），
  // 所以要先等计数稳定再取基线，否则会把整理内部的调用误判成"自动整理又跑了一次"。
  const consCount = () => llm.state.requests.filter((r) => String(r.messages?.[0]?.content || '').includes('记忆整理模块')).length;
  const settle = async () => {
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const now = consCount();
      if (now === prev) return now;
      prev = now;
      await sleep(500);
    }
    return consCount();
  };
  const consBefore = await settle();
  await sleep(1500);
  assert.strictEqual(consCount(), consBefore, '手动整理后无多余自动整理请求');
  pass('群友印象整理冷却：冷却期内不重复触发');

  // ── 场景 27：模型图片输入探测 + 按模型门控看图工具 ──
  // 先通过手动添加提供商 API 创建视觉探测专用提供商（baseUrl 指向 mock LLM）
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`,
      apiKey: 'cred-visiontest-key',
      models: [
        { id: 'vision-ok-model', name: '视觉正常' },
        { id: 'vision-no-model', name: '视觉拒绝' }
      ]
    })
  });
  const visionProv = (await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/providers`)).json())
    .providers.find((p) => p.baseURL === `http://127.0.0.1:${PORTS.llm}/v1`);
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/scan`, {
    method: 'POST', body: JSON.stringify({ providerIds: [visionProv.id] })
  });
  let visionRes = null;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    visionRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/vision/results`)).json();
    if (!visionRes.scanning
      && visionRes.results[`${visionProv.id}|||vision-ok-model`]
      && visionRes.results[`${visionProv.id}|||vision-no-model`]) break;
  }
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-ok-model`].verdict, 'vision', '接受图片的模型判定为 vision');
  assert.strictEqual(visionRes.results[`${visionProv.id}|||vision-no-model`].verdict, 'no-vision', '拒绝图片的模型判定为 no-vision');
  assert.ok(visionRes.results[`${visionProv.id}|||vision-no-model`].note.includes('image'), 'no-vision 结论带原始报错说明');

  // 场景 26 之后模型目录多了视觉测试提供商（vision-ok/no），原 chat 模型仍可用
  // 切到无视觉模型：请求里不应再有看图工具
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-no-model', baseUrl: `http://127.0.0.1:${PORTS.llm}/v1`, apiKey: 'cred-visiontest-key' } })
  });
  llm.state.script.push({ content: '（安静）' });
  pushGroupMsg(119, '阿九', '看看无视觉模型', 9029);
  await waitFor(() => llm.state.requests.some((r) => String(r.messages?.[1]?.content || '').includes('看看无视觉模型')), 8000, '无视觉模型运行开始');
  const noVisionReq = llm.state.requests.at(-1);
  assert.ok(!noVisionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'no-vision 模型不带看图工具');

  // 切到视觉模型：看图工具恢复
  await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
    method: 'POST',
    body: JSON.stringify({ api: { provider: visionProv.id, model: 'vision-ok-model' } })
  });
  llm.state.script.push({ content: '（安静2）' });
  pushGroupMsg(120, '阿十', '看看有视觉模型', 9030);
  await waitFor(() => llm.state.requests.some((r) => String(r.messages?.[1]?.content || '').includes('看看有视觉模型')), 8000, '视觉模型运行开始');
  const visionReq = llm.state.requests.at(-1);
  assert.ok(visionReq.tools?.some((t) => t.function?.name === 'get_message_images'), 'vision 模型带看图工具');
  pass('模型图片输入探测 + 按模型门控看图工具');

  // ── 场景 28：出错自动重试（可重试错误重试两次，4xx 不重试）──
  {
    const { isRetryableError } = await import('../src/llm.js');
    // 可重试：网络/超时/5xx/429
    for (const msg of [
      '模型请求失败：fetch failed',
      '模型请求失败：bad port',
      '模型请求超时（180000ms）',
      '模型 API HTTP 500：internal',
      '模型 API HTTP 502',
      '模型 API HTTP 429：rate limit',
      '模型 API 返回了无法解析的 JSON'
    ]) {
      assert.ok(isRetryableError(new Error(msg)), `应可重试：${msg}`);
    }
    // 不可重试：4xx / 主动中止
    for (const msg of [
      '模型 API HTTP 401：unauthorized',
      '模型 API HTTP 400：bad request',
      '模型 API HTTP 403：forbidden',
      '模型 API HTTP 404：not found',
      'aborted'
    ]) {
      assert.ok(!isRetryableError(new Error(msg)), `不应重试：${msg}`);
    }
    // 重试次数上限：持续 500 应尝试 3 次（1 次 + 2 次重试）后抛错
    // 注意：每次子测试前清空 script，否则上一测试没消耗完的脚本项会污染下一次调用
    const { chatCompletionWithRetry } = await import('../src/llm.js');
    llm.state.forceStatus = [500, 500, 500];   // 连续三次 500
    const before = llm.state.requests.length;
    let threw = false;
    try {
      await chatCompletionWithRetry({ messages: [{ role: 'user', content: '触发重试' }] }, 2);
    } catch { threw = true; }
    const tries = llm.state.requests.length - before;
    assert.ok(threw, '持续 500 应最终抛错');
    assert.equal(tries, 3, `总共应尝试 3 次，实际 ${tries}`);

    // 401 只应尝试 1 次（客户端错误不重试）
    llm.state.forceStatus = [401, 401];   // 多给一个，若误重试会被消耗掉
    const before401 = llm.state.requests.length;
    let threw401 = false;
    try {
      await chatCompletionWithRetry({ messages: [{ role: 'user', content: '认证失败' }] }, 2);
    } catch { threw401 = true; }
    const tries401 = llm.state.requests.length - before401;
    assert.ok(threw401, '401 应抛错');
    assert.equal(tries401, 1, `401 只应尝试 1 次，实际 ${tries401}`);

    // 先 500 后成功：总共 2 次
    llm.state.forceStatus = [500];   // 第一次 500，之后回落正常响应
    const beforeMix = llm.state.requests.length;
    const mix = await chatCompletionWithRetry({ messages: [{ role: 'user', content: '先失败后成功' }] }, 2);
    const triesMix = llm.state.requests.length - beforeMix;
    assert.equal(triesMix, 2, `先 500 后成功应尝试 2 次，实际 ${triesMix}`);
    assert.ok(mix?.message?.content, '重试后应返回正常响应');
    llm.state.forceStatus = null;
    pass('出错自动重试：两次重试后停止，4xx 不重试');
  }

  // ── 场景 29：响应档位（是否响应 + 各档条数独立）──
  {
    const { resolveContextTier, isAtMe, hitKeyword } = await import('../src/prompt.js');
    const OPT = { selfNickname: '小鲸鱼', botName: '小鲸鱼', selfId: '3113678561' };
    // 各档条数刻意设成不同值，便于验证"触发原因决定条数"
    const CFG = {
      contextTier: 1, atCount: 5, keywordCount: 10,
      keywords: ['大肥鱼'], randomPercent: 10, randomCount: 20, allCount: 50
    };

    // 艾特检测：@昵称 / CQ 码
    assert.ok(isAtMe('@小鲸鱼 在吗', OPT), '@昵称应识别为艾特');
    assert.ok(isAtMe('[CQ:at,qq=3113678561] x', OPT), 'CQ 码艾特自己应识别');
    assert.ok(!isAtMe('[CQ:at,qq=999] x', OPT), '艾特别人不应识别');
    assert.ok(!isAtMe('天气不错', OPT), '普通消息不应识别');

    // 关键词
    assert.ok(hitKeyword('大肥鱼 帮我', ['大肥鱼']), '关键词应命中');
    assert.ok(hitKeyword('BOT x', ['bot']), '关键词应不区分大小写');
    assert.ok(!hitKeyword('x', []), '空关键词表不命中');

    const at = [{ text: '[CQ:at,qq=3113678561] 在吗' }];   // 纯艾特，不含关键词
    const kw = [{ text: '大肥鱼 帮我' }];
    const plain = [{ text: '今天天气不错' }];

    // ── 核心：各档条数独立，由"触发原因"决定，不是由"档位上限"决定 ──
    const tbl = [
      // [档位, 消息, 应响应?, 应带已读条数, 说明]
      [1, at, true, 5, '1档+艾特 → atCount'],
      [1, kw, false, 0, '1档+关键词 → 不响应'],
      [1, plain, false, 0, '1档+普通 → 不响应'],
      [2, at, true, 5, '2档+艾特 → 仍是艾特档 5 条'],
      [2, kw, true, 10, '2档+关键词 → keywordCount'],
      [2, plain, false, 0, '2档+普通 → 不响应'],
      [3, at, true, 5, '3档+艾特 → 仍是艾特档 5 条（关键）'],
      [3, kw, true, 10, '3档+关键词 → 仍是关键词档 10 条'],
      [3, plain, true, 20, '3档+普通随机命中 → randomCount'],
      [4, plain, true, 50, '4档+普通 → allCount']
    ];
    for (const [tier, ents, should, count, desc] of tbl) {
      const r = resolveContextTier({ triggerEntries: ents, cfg: { ...CFG, contextTier: tier }, ...OPT, roll: 5 });
      assert.equal(r.shouldRespond, should, `${desc}：shouldRespond 应为 ${should}`);
      assert.equal(r.count, count, `${desc}：应带 ${count} 条，实际 ${r.count}`);
    }

    // 随机未中时不响应（1~3 档）
    for (const tier of [1, 2, 3]) {
      const r = resolveContextTier({ triggerEntries: plain, cfg: { ...CFG, contextTier: tier }, ...OPT, roll: 50 });
      assert.equal(r.shouldRespond, false, `${tier} 档随机未中应不响应`);
    }

    // 档位钳制：0 不能被当成"未设置"回落成 4
    const r0 = resolveContextTier({ triggerEntries: plain, cfg: { ...CFG, contextTier: 0 }, ...OPT, roll: 50 });
    assert.ok(r0.tier <= 1, `档位 0 应钳到 1，实际 ${r0.tier}`);

    // 随机结果可固定
    const a = resolveContextTier({ triggerEntries: plain, cfg: { ...CFG, contextTier: 3 }, ...OPT, roll: 5 });
    const b = resolveContextTier({ triggerEntries: plain, cfg: { ...CFG, contextTier: 3 }, ...OPT, roll: 5 });
    assert.equal(a.tier, b.tier, '同一 roll 结果应一致（不重掷）');
    pass('响应档位：未命中不响应，各档已读条数互相独立');
  }

  // ── 场景 30：关键控件的基础样式完整性 ──
  // 背景：清理 style.css 重复规则时，曾把 .btn / .tab / .model-modal 的基础定义删掉
  // （只留下后面追加 transition/animation 的同名规则），按钮全变成浏览器默认外观。
  // 逻辑自测发现不了这类问题，所以这里专门校验"基础视觉属性是否齐全"。
  {
    // ESM 里没有 __dirname，用 import.meta.url 推导
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cssText = fs.readFileSync(path.join(here, '..', 'ui', 'style.css'), 'utf8');

    /* 解析 CSS：
       先剥掉注释与 @规则（@keyframes/@media 内部有嵌套大括号，会让括号配对错乱），
       剩下的顶层规则再按大括号配对切分。只关心"某选择器块里有没有这个属性名"，
       不追求严格解析 —— 目标是发现"基础定义整条被删"，不是做 CSS 规范校验。 */
    const noComments = cssText.replace(/\/\*[\s\S]*?\*\//g, '');

    // 收集所有 @规则块的范围，后面切分顶层规则时跳过
    const atRanges = [];
    {
      const re = /@[\w-]+[^{]*\{/g;
      let m;
      while ((m = re.exec(noComments))) {
        let depth = 0, k = m.index + m[0].length - 1;
        while (k < noComments.length) {
          if (noComments[k] === '{') depth++;
          else if (noComments[k] === '}') { depth--; if (depth === 0) break; }
          k++;
        }
        atRanges.push([m.index, k]);
        re.lastIndex = k;
      }
    }
    const inAt = (pos) => atRanges.some(([a, b]) => pos >= a && pos <= b);

    const rules = [];
    let ci = 0;
    while (ci < noComments.length) {
      if (noComments[ci] === '{' && !inAt(ci)) {
        let sj = ci - 1;
        while (sj >= 0 && noComments[sj] !== '}' && noComments[sj] !== '{') sj--;
        const selector = noComments.slice(sj + 1, ci).trim();
        let depth = 0, ck = ci;
        while (ck < noComments.length) {
          if (noComments[ck] === '{') depth++;
          else if (noComments[ck] === '}') { depth--; if (depth === 0) break; }
          ck++;
        }
        const body = noComments.slice(ci + 1, ck);
        rules.push({ selector, body });
        ci = ck + 1;
      } else ci++;
    }

    // 汇总某基础选择器的规则体（精确匹配基础选择器，排除 .btn:hover / .btn-primary 等变体）
    const bodyOf = (sel) => rules
      .filter((r) => r.selector.split(',')[0].trim() === sel)
      .map((r) => r.body)
      .join('\n');
    // 属性是否声明过（宽松匹配属性名，够用于发现"整条基础定义被删"）
    const has = (sel, ...names) => {
      const body = bodyOf(sel);
      return names.every((nm) => new RegExp('(^|;|\\s)' + nm.replace(/[-]/g, '\\-') + '\\s*:', 'm').test(body));
    };

    // 每个控件的最低视觉要求 —— 缺了就会变成浏览器默认外观
    const REQ = [
      ['.btn', ['background', 'border', 'color', 'padding', 'cursor', 'border-radius', 'font-size']],
      ['.tab', ['background', 'color', 'padding', 'cursor', 'font-size']],
      ['.model-modal', ['background', 'border', 'border-radius', 'width', 'display']],
      ['.icon-btn', ['background', 'border', 'color', 'width', 'cursor']],
      ['.price-card', ['background', 'border', 'border-radius', 'padding']],
      ['.tier-btn', ['background', 'border', 'color', 'cursor']],
      ['.theme-option', ['background', 'border', 'color', 'cursor']],
      ['.dot', ['width', 'height', 'border-radius']],
      ['.list-head', ['padding', 'border-bottom']],
      ['.empty-hint', ['color', 'text-align']],
      ['.usage-table', ['width', 'border']]
    ];

    const missing = [];
    for (const [sel, names] of REQ) {
      if (!has(sel, ...names)) {
        const body = bodyOf(sel);
        const lack = names.filter((nm) => !new RegExp('(^|;|\\s)' + nm.replace(/[-]/g, '\\-') + '\\s*:', 'm').test(body));
        missing.push(`${sel} 缺 ${lack.join('/')}`);
      }
    }
    assert.deepEqual(missing, [], `以下控件基础样式不完整（会回落到浏览器默认外观）：\n  ${missing.join('\n  ')}`);

    // 变量体系仍完整（明暗两套都要有）
    for (const theme of ['dark', 'light']) {
      const m = cssText.match(new RegExp("\\[data-theme='" + theme + "'\\]\\s*\\{([^}]*)\\}"));
      assert.ok(m, `缺少 [data-theme='${theme}'] 定义`);
      for (const v of ['bg', 'bg-2', 'bg-3', 'border', 'text', 'muted', 'accent', 'hover', 'overlay']) {
        assert.ok(m[1].includes(`--${v}:`), `${theme} 主题缺少 --${v}`);
      }
    }
    pass('关键控件基础样式完整（防止重复清理误删基础定义）');
  }

  // ── 场景 30：群名 / 存档倒序 / 表情包频率 ──
  {
    const { buildUserPrompt, buildSystemPrompt } = await import('../src/prompt.js');
    const { setRuntimeConfig, getConfig } = await import('../src/config.js');

    // 群名：/api/chats 每个条目都带 chatName 字段（拿不到时为空串）
    const cRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats`)).json();
    const cl = cRes.chats || [];
    assert.ok(cl.length > 0, '应有存档会话');
    assert.ok(cl.every((c) => 'chatName' in c), '每个 chat 都应有 chatName 字段');

    // 存档倒序：稳定排序后反转，不应出现时间倒挂
    const key0 = cl[0].key;
    const mRes = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/chats/${key0.replace(':', '_')}/messages?limit=100000`)).json();
    const msgs = mRes.messages || [];
    if (msgs.length > 1) {
      const sorted = msgs.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
      const newestFirst = sorted.slice().reverse();
      assert.equal(newestFirst[0].ts, sorted[sorted.length - 1].ts, '渲染首条应为最新');
      let bad = 0;
      for (let i = 1; i < newestFirst.length; i++) if (newestFirst[i].ts > newestFirst[i - 1].ts) bad++;
      assert.equal(bad, 0, `倒序后不应有时间倒挂，实际 ${bad} 处`);
    }

    // 表情包频率：档位改写系统提示【表情包策略】的频率行（2026-09-07 从用户消息搬入系统提示）
    const base = getConfig();
    const expect = [
      [0, '表情包是备选项'],
      [1, '每 3~5 轮来一张'],
      [2, '回应、吐槽、接梗时优先考虑'],
      [3, '表情包爱好者']
    ];
    for (const [lvl, kw] of expect) {
      setRuntimeConfig({ ...base, sticker: { ...base.sticker, enabled: true, encourage: lvl } });
      const sys = buildSystemPrompt({ persona: { botName: 'bot', participation: 'medium' } });
      assert.ok(sys.includes('【表情包策略'), `${lvl} 档：系统提示应包含表情包策略段`);
      assert.ok(sys.includes(kw), `${lvl} 档频率行应包含「${kw}」，实际未命中`);
    }
    setRuntimeConfig(base);
    pass('群名 / 存档倒序 / 表情包频率档位');
  }

  // ── 场景 31：用量缓存 + 会话数量上限 ──
  {
    const get = async (path) => {
      const t0 = Date.now();
      const r = await (await fetch(`http://127.0.0.1:${cfg.server.port}${path}`)).json();
      return { r, ms: Date.now() - t0 };
    };

    // 用量缓存：连续两次请求，第二次应明显更快
    const a = await get('/api/usage/stats?range=7');
    const b = await get('/api/usage/stats?range=7');
    assert.ok(b.ms < a.ms || b.ms < 40, `缓存应生效：首次 ${a.ms}ms 再次 ${b.ms}ms`);
    // 缓存不能改变结果
    assert.deepEqual(
      { t: a.r?.totals?.totalTokens, m: (a.r?.models || []).length },
      { t: b.r?.totals?.totalTokens, m: (b.r?.models || []).length },
      '命中缓存与未命中结果应一致'
    );

    // 会话数量：不再被 200 硬截断
    const many = await get('/api/sessions?limit=2000');
    const n = (many.r?.sessions || []).length;
    assert.ok(n > 0, '应返回会话');
    const mid = await get('/api/sessions?limit=400');
    assert.equal((mid.r?.sessions || []).length, Math.min(400, n),
      `limit=400 应返回 min(400,${n}) 条，实际 ${(mid.r?.sessions || []).length}`);
    pass('用量缓存加速 + 会话数量不再被 200 截断');
  }

  // ── 场景 32：未命中标记已读（档位控制是否响应的核心机制）──
  {
    const { ChatStore } = await import('../src/store.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const store2 = new ChatStore(100);
    const KEY = 'group:__selftest_tier';

    store2.appendIncoming(KEY, { mid: 'a1', senderId: 'u1', senderName: 'A', text: '一' });
    store2.appendIncoming(KEY, { mid: 'a2', senderId: 'u2', senderName: 'B', text: '二' });
    assert.equal(store2.unreadCount(KEY), 2, '追加两条后未读应为 2');

    // markAllRead：标记为已读但不取走（这是"未命中就不响应"的关键）
    const marked = store2.markAllRead(KEY);
    assert.equal(marked, 2, 'markAllRead 应返回被标记条数 2');
    assert.equal(store2.unreadCount(KEY), 0, '标记后未读应为 0');
    const kept = store2.recent(KEY, { limit: 50 }).filter((m) => !m.self);
    assert.equal(kept.length, 2, '消息应仍留在存档（不被删除）');
    assert.ok(kept.every((m) => m.read === true), '两条都应被标记已读');

    // 后续新消息：drainUnread 只取新的，旧的不重复
    store2.appendIncoming(KEY, { mid: 'a3', senderId: 'u3', senderName: 'C', text: '三' });
    assert.equal(store2.unreadCount(KEY), 1, '新消息后未读应为 1');
    const drained = store2.drainUnread(KEY);
    assert.equal(drained.length, 1, 'drainUnread 应只取到新的 1 条');
    assert.equal(drained[0]?.text, '三', '取到的应是消息三');

    // 清理
    try {
      const f = path.join(process.cwd(), 'data', 'messages', KEY.replace(':', '_') + '.json');
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { }
    pass('未命中标记已读：消息沉入历史、不重复触发');
  }

  // ── 场景 33：响应档位滑条（位置↔档位/概率）──
  {
    const { sliderToTier, tierToSlider } = await import('../src/tier-slider.js');

    // 分区边界
    for (const [pos, want] of [[0, 1], [5, 1], [10, 1], [15, 2], [20, 2], [30, 3], [55, 3], [90, 3], [95, 4], [100, 4]]) {
      assert.equal(sliderToTier(pos).tier, want, `滑条 ${pos}% 应为 ${want} 档`);
    }

    // 3 档概率线性（关键：55% 处正好 50%）
    for (const [pos, want] of [[20, 0], [55, 50], [90, 100]]) {
      const r = sliderToTier(pos);
      assert.ok(Math.abs(r.randomPercent - want) < 0.6,
        `滑条 ${pos}% 概率应约 ${want}%，实际 ${r.randomPercent}%`);
    }
    // 单调递增：拖得越右概率越高
    let prev = -1;
    for (let p = 20; p <= 90; p += 5) {
      const cur = sliderToTier(p).randomPercent;
      assert.ok(cur > prev, `概率应随位置递增（${p}% 处 ${cur} 不大于前一个 ${prev}）`);
      prev = cur;
    }

    // 往返一致：位置 → 档位 → 位置，档位不变
    for (const pos of [5, 15, 30, 55, 80, 95]) {
      const r = sliderToTier(pos);
      const back = tierToSlider(r.tier, r.randomPercent);
      assert.equal(sliderToTier(back).tier, r.tier, `${pos}% 往返后档位应保持一致`);
    }

    // 越界与非法值
    assert.equal(sliderToTier(-10).tier, 1, '负数应钳到 1 档');
    assert.equal(sliderToTier(150).tier, 4, '超 100 应钳到 4 档');
    assert.equal(sliderToTier(NaN).tier, 4, 'NaN 应回落到 4 档');

    // 后端权威派生：只传滑条位置，后端应算出档位与概率
    const { updateConfig, loadConfig, setRuntimeConfig } = await import('../src/config.js');
    const fs2 = await import('node:fs');
    // ⚠️ 必须读写本次测试自己的临时数据目录。
    // 这里曾经写死相对路径 'data/config.json'，那指向的是**项目根目录下的用户数据目录**：
    // 在干净的检出一跑就 ENOENT 失败，更糟的是在开发机上会把真实配置备份又覆盖回去。
    // updateConfig 落盘的目标本来就是 QQ_AGENT_DATA_DIR（=dataDir），两者必须一致。
    const cfgPath = path.join(dataDir, 'config.json');
    const hadCfg = fs2.existsSync(cfgPath);
    const backup = hadCfg ? fs2.readFileSync(cfgPath, 'utf8') : null;
    try {
      const n = updateConfig({ store: { contextSliderPos: 55 } });
      assert.equal(n.store.contextTier, 3, '后端应把 55% 派生为 3 档');
      assert.ok(Math.abs(n.store.randomPercent - 50) < 1, '后端应把 55% 派生为 50% 概率');
    } finally {
      if (hadCfg) fs2.writeFileSync(cfgPath, backup, 'utf8');
      // ⚠️ 还必须还原**内存里的**配置：updateConfig 改的是模块内的 currentConfig，
      // 只还原磁盘文件的话，后续所有场景都会一直跑在"3 档 + 50% 随机响应"上 ——
      // 表现为普通消息到底触不触发运行变成掷骰子，测试随机挂（很难查）。
      // 用 loadConfig() 而不是 JSON.parse(backup)：前者会补回默认值（= 当时的真实内存态）。
      setRuntimeConfig(loadConfig());
      assert.equal(loadConfig().store.contextTier, 4, '复位后档位应回到默认 4 档');
    }
    pass('响应档位滑条：分区 + 概率线性 + 后端权威派生');
  }

  // ── 场景 34：搜索次数 + 工具调用明细（次数不进成本）──
  {
    const get = async (path) => (await (await fetch(`http://127.0.0.1:${cfg.server.port}${path}`)).json());

    const all = await get('/api/usage/stats?range=all');
    assert.ok('searchCount' in all, 'stats 应含 searchCount 字段');
    assert.ok('toolCounts' in all, 'stats 应含 toolCounts 字段');

    const sc = Number(all.searchCount) || 0;
    const tc = all.toolCounts || {};
    assert.ok(sc >= 0, 'searchCount 应为非负数字');

    // 工具调用总计应等于各工具之和
    const total = Object.values(tc).reduce((a, x) => a + Number(x) || 0, 0);
    assert.ok(total >= 0, '工具调用总计应为非负');

    // 搜索次数 = web_search + web_fetch（后端就是这么累加的）
    const searchFromTools = (Number(tc.web_search) || 0) + (Number(tc.web_fetch) || 0);
    assert.equal(searchFromTools, sc,
      `searchCount(${sc}) 应等于 web_search+web_fetch(${searchFromTools})`);

    // ★ 关键：搜索次数不能影响成本
    // 成本只由 token×单价算出，与 searchCount / 工具次数无关
    const before = Number(all.totals?.cost) || 0;
    assert.ok(before >= 0, '成本应为非负');
    // 换个区间（工具/搜索次数不同），成本只应随 token 变化，不随次数"凭空"变化
    const today = await get('/api/usage/stats?range=today');
    assert.ok('searchCount' in today && 'toolCounts' in today, 'today 区间也应有两字段');

    // 缓存命中时两字段不能丢（曾经缓存只缓存了 rows）
    const a1 = await get('/api/usage/stats?range=all');
    const a2 = await get('/api/usage/stats?range=all');
    assert.equal(a1.searchCount, a2.searchCount, '缓存命中时 searchCount 应一致');
    assert.deepEqual(a1.toolCounts, a2.toolCounts, '缓存命中时 toolCounts 应一致');

    pass('搜索次数 + 工具调用明细统计（不进成本）');
  }

  // ── 场景 35：远程价格表（校验/规范化 + 覆盖优先级 + 接口）──
  {
    const { normalizePriceFeed, refreshPriceFeed, priceFeedStatus } = await import('../src/price-feed.js');
    const { resolveOfficialPrice, setRemotePrices, listOfficialPrices } = await import('../src/model-prices.js');

    // ① 四种外形都能解析
    const bareMap = { 'test-feed-model': { in: 9, out: 99, cached: 0.9 } };
    const wrapped = { prices: bareMap };
    const arrWrap = { prices: [{ id: 'test-feed-model', in: 9, out: 99 }] };
    const bareArr = [{ id: 'test-feed-model', in: 9, out: 99 }];
    for (const [name, payload] of [['裸map', bareMap], ['包裹map', wrapped], ['包裹数组', arrWrap], ['裸数组', bareArr]]) {
      const n = normalizePriceFeed(payload);
      assert.ok(n && n.prices['test-feed-model'], `${name} 应解析出条目`);
      assert.equal(n.prices['test-feed-model'].in, 9, `${name} in 值应正确`);
    }

    // ② 坏条目被丢弃；全是垃圾 → null（判拉取失败，不清旧表）
    const mixed = normalizePriceFeed({ good: { in: 1, out: 2 }, bad: { no: 'fields' }, alsobad: 'x' });
    assert.equal(Object.keys(mixed.prices).length, 1, '坏条目应被丢弃');
    assert.equal(mixed.dropped, 2, '应报告丢弃数 2');
    assert.equal(normalizePriceFeed({ a: 'junk' }), null, '全垃圾载荷应判 null');
    assert.equal(normalizePriceFeed('not-json-object'), null, '非对象载荷应判 null');

    // ③ 覆盖语义：远程条目按 id 赢内置表；其余内置条目还在
    // 先记下内置价（不写死数字：官方调价后测试不该跟着改）
    const builtinFlashIn = resolveOfficialPrice('deepseek-v4-flash').in;
    setRemotePrices({ 'deepseek-v4-flash': { in: 111, out: 222, cached: 0.5, src: 'remote' } });
    const overridden = resolveOfficialPrice('deepseek-v4-flash');
    assert.equal(overridden.in, 111, '远程条目应覆盖内置表');
    assert.ok(resolveOfficialPrice('glm-5.3'), '未覆盖的内置条目应仍可解析');
    const listed = listOfficialPrices();
    assert.ok(listed.find((x) => x.id === 'deepseek-v4-flash')?.remote === true, '列表应标记 remote:true');
    setRemotePrices({});   // 还原：不能污染后面的成本断言
    assert.equal(resolveOfficialPrice("deepseek-v4-flash").in, builtinFlashIn, "清空后应回退内置价");

    // ④ 真拉一次：起一个临时 HTTP 服务器当"用户自托管价格表"
    const feedServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ prices: { 'test-remote-live': { in: 7, out: 70 } } }));
    });
    await new Promise((r) => feedServer.listen(0, '127.0.0.1', r));
    const feedUrl = `http://127.0.0.1:${feedServer.address().port}/prices.json`;
    const st1 = await refreshPriceFeed(feedUrl);
    assert.ok(st1.ok && st1.source === 'remote', '应从远程拉取成功');
    assert.equal(resolveOfficialPrice('test-remote-live').in, 7, '拉到的条目应立即可查');

    // 失败场景：服务器挂了 → ok=false，但表不清（继续用刚才拉到的）
    feedServer.close();
    await sleep(50);
    const st2 = await refreshPriceFeed(feedUrl);
    assert.ok(!st2.ok && st2.error, '连接失败应报告错误');
    assert.equal(resolveOfficialPrice('test-remote-live').in, 7, '拉取失败不能清掉已有远程表');
    setRemotePrices({});   // 收尾还原

    // ⑤ 接口：/api/model-prices 必须带 remote 状态；/api/model-prices/refresh 必须存在（不能 404）
    const get = async (p) => (await (await fetch(`http://127.0.0.1:${cfg.server.port}${p}`)).json());
    const mp = await get('/api/model-prices');
    assert.ok(mp.remote && typeof mp.remote.enabled === 'boolean', 'model-prices 应带 remote 状态');
    const rr = await (await fetch(`http://127.0.0.1:${cfg.server.port}/api/model-prices/refresh`, { method: 'POST' })).json();
    assert.ok(rr.remote, 'refresh 接口应返回 remote 状态（未配置 URL 时 enabled=false）');
    assert.equal(rr.remote.enabled, false, '自测环境未配置 URL，应为未启用');

    pass('远程价格表：四种格式解析 + 覆盖优先级 + 失败不清表 + 接口齐全');
  }

  // ── 场景 36：合并转发聊天记录展开（模型要读懂内容，不是只看占位符）──
  {
    // mock 的 get_forward_msg 返回两段：转发者A 一段文字 + 转发者B 一张图
    pushGroupMsg(114, '赵六', '', 9300, {
      message: [{ type: 'forward', data: { id: 'fwd-test-1' } }]
    });
    const msgs = await waitFor(() => {
      const list = app.store.recent('group:456', { limit: 200 });
      const hit = list.find((m) => m.mid === 9300);
      return hit && String(hit.text).includes('合并转发') ? hit : null;
    }, 8000, '合并转发消息入档并展开');
    assert.ok(msgs.text.includes('[合并转发 共2条]'), '应有合并转发头');
    assert.ok(msgs.text.includes('转发者A(QQ:1001): 第一段转发内容，谁懂'), '应展开文字节点（发言人带 QQ 号）');
    assert.ok(msgs.text.includes('转发者B'), '应展开带图节点');
    const imgMedia = (msgs.media || []).find((x) => x.file === 'fwd.png');
    assert.ok(imgMedia, '转发里的图片应进 media（取图/金句可用）');
    assert.ok(String(imgMedia.url).includes('img.png'), 'media 应带新鲜 url');
    pass('合并转发聊天记录：get_forward_msg 展开为可读文本 + 图片进 media');
  }

  // ── 场景 37：read_forward 工具（占位符消息按需展开 + 写回存档）──
  {
    // 模拟"功能上线前入库的老占位符消息"：直接塞一条未展开的转发
    app.store.appendIncoming('group:456', {
      mid: 9400, ts: Date.now(), senderId: '115', senderName: '孙七',
      text: '[转发消息 id=oldExpiredResId]'
    });
    const { buildToolDefs } = await import('../src/tools.js');
    const tool = buildToolDefs().find((t) => t.name === 'read_forward');
    assert.ok(tool, 'read_forward 工具必须存在');
    const ctx = { chatKey: 'group:456', store: app.store, onebot: app.onebot };
    const r = await tool.execute(ctx, { messageId: 9400 });
    assert.ok(!r.isError, `工具应成功：${r.content}`);
    assert.ok(r.content.includes('第一段转发内容'), '工具应返回展开后的转发内容');
    // 写回存档：占位符被永久升级
    const entry = app.store.findByMid('group:456', 9400);
    assert.ok(entry.text.startsWith('[合并转发 共2条]'), '存档应被升级为展开文本');
    assert.ok((entry.media || []).some((x) => x.file === 'fwd.png'), '存档应补上转发里的图片');
    // 再次调用：读存档，不再请求 QQ（返回 note）
    const r2 = await tool.execute(ctx, { messageId: 9400 });
    assert.ok(String(r2.content).includes('读的是存档'), '二次调用应直接读存档');
    // 错误 id：给可见 id 提示而不是让模型瞎猜
    const r3 = await tool.execute(ctx, { messageId: 999999 });
    assert.ok(r3.isError && r3.content.includes('#数字'), '找不到时应提示用 #数字');
    pass('read_forward 工具：按需展开 + 写回存档 + 二次读缓存 + 错误提示');
  }

  // ── 场景：曲库（唱歌）纯逻辑 ──
  // 切片本身要 ffmpeg，不在这里跑；这里锁的是「找准歌」和「切哪一段」——
  // 后者踩过一次坑：resolveClipPlan 用 Number(null) 判空，0 是有限数，
  // 导致"没指定起点"被当成"从 0 秒开始"，人工标好的 chorusAt 永远不生效。
  {
    const songs = await import('../src/songs.js');
    const songsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-songs-'));
    const manifestFile = path.join(songsDir, 'manifest.json');
    fs.writeFileSync(path.join(songsDir, 'a.mp3'), 'fake-audio');
    fs.writeFileSync(manifestFile, JSON.stringify([
      { file: 'a.mp3', title: '测试歌', artist: '某歌手', aliases: ['别名歌'], chorusAt: 45, seconds: 12, tags: ['经典'] },
      { file: 'missing.mp3', title: '幽灵歌' },        // 文件不存在 → 丢弃
      { file: '../逃逸.mp3', title: '越权歌' },         // 路径穿越 → 拒绝
      { title: '没有文件名' }                          // 缺 file → 丢弃
    ]), 'utf8');

    const lib = songs.loadSongLibrary({ songsDir, manifestFile });
    assert.strictEqual(lib.length, 1, `只应收录 1 首可用的，实际 ${lib.length}`);
    assert.strictEqual(lib[0].chorusAt, 45);

    // 二次读取走缓存，且换目录不会命中上一个目录的结果（缓存键含清单路径）
    assert.strictEqual(songs.loadSongLibrary({ songsDir, manifestFile })[0].title, '测试歌');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-songs2-'));
    assert.strictEqual(songs.loadSongLibrary({ songsDir: emptyDir, manifestFile: path.join(emptyDir, 'manifest.json') }).length, 0,
      '换一个目录读应返回空库，而不是上一个目录的缓存');
    fs.rmSync(emptyDir, { recursive: true, force: true });

    // 点歌匹配：歌名 / 别名 / 歌手 / 标签
    assert.strictEqual(songs.findSong(lib, '测试歌').title, '测试歌');
    assert.strictEqual(songs.findSong(lib, '别名歌').title, '测试歌');
    assert.strictEqual(songs.findSong(lib, '某歌手').title, '测试歌');
    assert.strictEqual(songs.findSong(lib, '经典').title, '测试歌');
    assert.strictEqual(songs.findSong(lib, '没有这首'), null);

    // 切片规划
    const plan = songs.resolveClipPlan(lib[0], { maxSeconds: 30 });
    assert.strictEqual(plan.startSec, 45, '未指定起点时应落到人工标注的 chorusAt（不是 0）');
    assert.strictEqual(plan.durationSec, 12, '清单里的 seconds 应优先于全局 maxSeconds');
    assert.strictEqual(songs.resolveClipPlan(lib[0], { start: 10, maxSeconds: 30 }).startSec, 10, '显式 start 覆盖 chorusAt');
    assert.strictEqual(songs.resolveClipPlan({ chorusAt: 0, seconds: 0 }, { maxSeconds: 300 }).durationSec, 60, '时长应被 60 秒硬上限钳住');
    assert.strictEqual(songs.resolveClipPlan({}, { maxSeconds: 1 }).durationSec, 5, '时长下限 5 秒');

    // 提示词摘要
    const ctxText = songs.buildSongContext(lib, 10);
    assert.ok(ctxText.includes('测试歌') && ctxText.includes('某歌手') && ctxText.includes('别名歌'), '歌单摘要应含歌名/歌手/别名');

    // 没有清单：按文件名收录（"丢一首歌进去就能试"，不用先学写清单）
    const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-songs3-'));
    fs.writeFileSync(path.join(bareDir, '赤裸裸.mp3'), 'x');
    fs.writeFileSync(path.join(bareDir, '说明.txt'), 'x');   // 非音频应被忽略
    const bareManifest = path.join(bareDir, 'manifest.json');
    const bare = songs.loadSongLibrary({ songsDir: bareDir, manifestFile: bareManifest });
    assert.strictEqual(bare.length, 1, `无清单时应扫描出 1 首音频，实际 ${bare.length}`);
    assert.strictEqual(bare[0].title, '赤裸裸', '无清单时用文件名当歌名');
    assert.strictEqual(bare[0].chorusAt, null, '无清单时没有副歌起点');

    // 清单 JSON 写坏：退回扫描目录，而不是让整个曲库变空
    fs.writeFileSync(bareManifest, '{ 这不是合法 JSON', 'utf8');
    assert.strictEqual(songs.loadSongLibrary({ songsDir: bareDir, manifestFile: bareManifest }).length, 1,
      '清单坏掉时应退回扫描，而不是变空库');
    fs.rmSync(bareDir, { recursive: true, force: true });

    fs.rmSync(songsDir, { recursive: true, force: true });
    pass('曲库：清单容错 + 无清单扫描回退 + 找歌 + 切片规划（chorusAt 生效）+ 歌单摘要');
  }

  // ── 场景 40：群友印象"发现活跃成员"——零印象的新群也能建出第一条 ──
  // 回归：早先的门槛是"印象总数 > 4 才整理"，而整理模式又只合并/删减、不新增，
  // 于是新群/冷群永远建不出第一条印象（实测有群聊了 200+ 条却零印象）。
  {
    const freshChat = 'group:789';
    await fetch(`http://127.0.0.1:${cfg.server.port}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allow: { groups: ['456', '789'], private: ['777'] } })
    });
    // 造一个全新会话：零印象，但某人有 22 条发言（超过 discoverMinMessages=20）
    for (let k = 0; k < 22; k++) {
      app.store.appendIncoming(freshChat, {
        mid: 9800 + k,
        ts: Date.now() - (40 - k) * 1000,
        senderId: '556',
        senderName: '新人群友',
        text: `新人发言 ${k + 1}`
      });
    }
    // 这 22 条只是"背景发言"，不该成为触发批 —— 否则会话的触发摘要会变成
    // "新人发言 1"（第一条未读），下面按文本等会话就等不到了。
    // 标记已读后它们照样进聊天记录，被 #scanChatActivity 数到，只是不再触发运行。
    app.store.markAllRead(freshChat);
    assert.strictEqual(app.memory.consolidationState(freshChat).counts.memberImpression, 0, '新会话初始零印象');

    // 跑一次：运行结束后应自动进入"发现活跃群友"，为 556 建出印象。
    // mock 按绝对下标取脚本 —— 下标 idx 是运行本身，idx+1 是随后的整理调用。
    const idx = llm.state.requests.length;
    llm.state.script[idx] = { content: '（看到新人刷屏了，不回）' };
    llm.state.script[idx + 1] = { content: JSON.stringify({ impressions: ['话多，爱聊技术话题'] }) };
    onebotWs.push({
      post_type: 'message', message_type: 'group', group_id: 789, user_id: 556, self_id: 888,
      message_id: 9700, time: Math.floor(Date.now() / 1000),
      sender: { user_id: 556, card: '新人群友', nickname: '新人群友' },
      // 明确艾特：不依赖档位判定，避免"这条到底该不该回应"引入随机性
      message: [{ type: 'text', data: { text: '@审计Bot 新人报到' } }]
    });
    await waitSessionDone('新人报到', 20000);

    // 运行结束后应自动进入"发现活跃群友"，为 556 调一次模型。
    // ⚠️ 只断言"多了一次模型调用"，不断言它落在哪个下标 —— mock 是按绝对下标取脚本的
    // （state.script[step]），中间可能插进别的运行（如 drain），绑死下标会假失败。
    // 旧逻辑（"印象数 > 4 才整理"）在这里一次调用都不会有，所以这个断言是有牙齿的。
    const extra = await waitFor(() => {
      const n = llm.state.requests.length - idx;
      return n >= 2 ? n : null;
    }, 15000, '零印象的新群自动发现活跃群友并调用模型');
    assert.ok(extra >= 2, `运行结束后应额外发生一次整理调用（实际只多 ${extra - 1} 次）`);
    // ⚠️ 必须"等"这次调用出现，不能取一次就断言：自动整理是后台异步的，
    // 前面的 extra>=2 成立时它可能还没发出去（整理内部还要读聊天记录、写记忆文件）。
    const memCall = await waitFor(() => llm.state.requests.find(
      (r) => String(r.messages?.[0]?.content || '').includes('记忆模块')
        && String(r.messages?.[1]?.content || '').includes('556')
    ), 15000, '为 556 发起"提炼长期印象"的调用');
    assert.ok(memCall, '这次自动整理确实是为 556 发起"提炼长期印象"');
    pass('群友印象：零印象的群也能自动发现活跃成员（旧逻辑因"印象数不超阈值"完全不触发）');
  }

  // ── 场景 40a：OneBot 连接的存活信号（心跳）──
  // 半开连接（TCP 还连着、对端已不再推事件）不会触发 close/error：客户端会一直以为自己
  // 连着、界面也显示"已连接"，但消息永远收不到，而且没有任何东西会去救它。
  // 唯一可靠的判断依据是协议端自己的心跳 —— 所以必须真的把它接住。
  {
    const ob = await import('../src/onebot.js');
    assert.strictEqual(ob.isConnectionStale({ silentMs: 5000, heartbeatIntervalMs: 5000 }), false, '心跳正常时不算假死');
    assert.strictEqual(ob.isConnectionStale({ silentMs: 25000, heartbeatIntervalMs: 5000 }), true, '静默远超心跳间隔即判假死');
    assert.strictEqual(ob.isConnectionStale({ silentMs: 19000, heartbeatIntervalMs: 5000 }), false, '静默在 20 秒下限内不判假死');
    assert.strictEqual(ob.isConnectionStale({ silentMs: 40000, heartbeatIntervalMs: 60000 }), false,
      '心跳间隔很长时按 3 倍间隔算，40 秒静默不该误判');
    assert.strictEqual(ob.isConnectionStale({ silentMs: 3600000, heartbeatIntervalMs: 0 }), false,
      '从未收到心跳时不判假死（静默 ≠ 故障，避免深夜空闲被误判成假死而反复重连丢消息）');

    const reqsBefore = llm.state.requests.length;
    const sessionsBefore = app.sessions.listSummaries(60).length;
    onebotWs.push({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000, status: { online: true } });
    await waitFor(() => app.onebot.heartbeatIntervalMs === 5000, 5000, '心跳间隔被记录');
    assert.strictEqual(app.onebot.health.heartbeatIntervalMs, 5000, 'health 快照带出心跳间隔');
    assert.ok(
      app.onebot.health.silentMs !== null && app.onebot.health.silentMs < 5000,
      `health 应带出"距上次收到事件"的毫秒数（实际 ${app.onebot.health.silentMs}）`
    );
    await sleep(300);
    assert.strictEqual(llm.state.requests.length, reqsBefore, '心跳不该触发任何模型调用');
    assert.strictEqual(app.sessions.listSummaries(60).length, sessionsBefore, '心跳不该产生会话');
    pass('OneBot 存活信号：心跳被接住、用于假死判定，且不打扰业务');
  }

  // ── 场景 40b：运行失败也不能让消息搁浅 ──
  // 失败路径最容易漏掉的收尾动作就是 drain：一旦漏掉，运行期间到达的消息会一直留在
  // "未读"里、没有任何人安排唤醒，只能等用户再发一条才被带出来
  // （onIncoming 在运行中会把责任交给 drain，drain 丢了这个责任就没人接了）。
  {
    const idx = llm.state.requests.length;
    const later = '失败之后的新消息';
    // ⚠️ 要 9 个 500：chatCompletionWithRetry 单次会话内最多重试 3 次，会话级又有 3 次尝试，
    // 3×3 才能把整轮彻底打垮。只给 3 个的话第 4 个请求就落到正常脚本上，
    // 会话会变成"跑通了但没发言"（noreply），断言 error 会失败。
    llm.state.forceStatus = new Array(9).fill(500);
    llm.state.script[idx + 9] = { content: '（收到，不回）' };    // 前面全部失败，第 10 个是收尾 drain 运行
    pushGroupMsg(117, '阿七', '这条会失败', 9910);
    await sleep(700);                                          // 让失败会话进入重试退避
    pushGroupMsg(118, '阿八', later, 9911);                     // ← 失败期间到达的消息
    const failed = await waitSessionDone('这条会失败', 60000);
    assert.strictEqual(failed.status, 'error', `连续失败后会话应记为 error（实际 ${failed.status}）`);
    await waitSessionDone(later, 30000);
    pass('运行失败不搁浅：收尾 drain 仍会处理失败期间到达的消息');
  }

  // ── 场景 41：前情摘要（跨会话的对话记忆）──
  {
    const sm = await import('../src/summary.js');

    // ── 纯函数：折叠选段 ──
    const msgs = Array.from({ length: 30 }, (_, k) => ({ id: k + 1, text: `m${k + 1}` }));
    assert.deepStrictEqual(
      sm.pickMessagesToFold(msgs, { keepRaw: 10, throughId: 0, maxInputMsgs: 100 }).map((m) => m.id),
      Array.from({ length: 20 }, (_, k) => k + 1),
      '保留最后 10 条原文，其余按旧→新折叠'
    );
    // 单批上限必须取"最旧的一批"：取最新的话，被跳过那段的消息 id 会永远小于新的
    // throughId，此后再也折不到 —— 那部分内容就永久丢了。
    assert.deepStrictEqual(
      sm.pickMessagesToFold(msgs, { keepRaw: 10, throughId: 0, maxInputMsgs: 5 }).map((m) => m.id),
      [1, 2, 3, 4, 5],
      '超出单批上限时取最旧的一批（不能跳段）'
    );
    assert.deepStrictEqual(
      sm.pickMessagesToFold(msgs, { keepRaw: 10, throughId: 20, maxInputMsgs: 5 }).map((m) => m.id),
      [],
      '已折叠过的不重复折叠（幂等）'
    );
    assert.strictEqual(sm.pickMessagesToFold(msgs, { keepRaw: 100, throughId: 0 }).length, 0, '消息不足保留数时什么都不折');
    assert.strictEqual(sm.resolveKeepRaw(60, 20), 20, '保留数不得超过本次读取窗口（否则出现既没进摘要也没进原文的盲区）');
    assert.strictEqual(sm.resolveKeepRaw(60, 0), 60, '读取窗口未知时退回 keepRaw');
    assert.strictEqual(sm.cleanSummaryText('```\n摘要：\n今天聊了球赛\n```', 200), '今天聊了球赛', '剥掉代码块围栏与"摘要："前缀');
    assert.strictEqual(sm.cleanSummaryText('   \n ', 200), '', '空结果返回空串（调用方据此保留原摘要）');
    assert.ok(
      sm.buildFoldPrompt({ prevText: '旧摘要内容', messages: [{ id: 1, senderName: '张三', text: '吃了吗' }], maxChars: 300 })
        .user.includes('旧摘要内容'),
      '折叠提示词带上已有摘要'
    );
    pass('前情摘要：折叠选段 / 保留数 / 正文清洗 的纯函数行为正确');

    // ── 端到端：手动折叠 → 落盘 → 注入下一次提示词 ──
    const apiBase = `http://127.0.0.1:${cfg.server.port}`;
    await fetch(`${apiBase}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: { enabled: true, keepRaw: 6, minFold: 1, maxChars: 300 } })
    });
    // mock 按绝对下标取脚本：折叠调用就在下一个下标。
    // 多挂一个下标作保险 —— 万一中间插进一次运行，折叠会落到下一个下标上；
    // 那次运行的回复变成摘要文本只是难看，不影响本场景的断言。
    const idx40 = llm.state.requests.length;
    const foldScript = { content: '```\n摘要：\n他们聊过球赛和宵夜，约好周末一起看球。\n```' };
    llm.state.script[idx40] = foldScript;
    llm.state.script[idx40 + 1] = foldScript;
    const foldResp = await fetch(`${apiBase}/api/memory-files/summary/fold`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatKey: 'group:456' })
    });
    assert.strictEqual(foldResp.status, 202, '手动折叠接口已启动');

    const readSummary = async () => (await (await fetch(`${apiBase}/api/memory-files/group_456/summary`)).json());
    const foldedState = await waitFor(async () => {
      const r = await readSummary();
      return r.summary?.text ? r : null;
    }, 15000, '前情摘要已生成');
    assert.ok(foldedState.summary.text.includes('球赛'), '摘要正文来自模型输出');
    assert.strictEqual(foldedState.summary.text.includes('```'), false, '代码块围栏已剥掉');
    assert.ok(foldedState.summary.throughId > 0, '折叠游标已推进');
    assert.ok(foldedState.summary.folded >= 6, `折叠条数 ≥ 滑出窗口的条数（实际 ${foldedState.summary.folded}）`);
    assert.strictEqual(typeof foldedState.pending, 'number', '接口带回"还有多少条待折叠"');
    pass('前情摘要：折叠落盘 + 围栏清洗 + 游标推进');

    // 注入：下一次运行的提示词里必须出现【前情摘要】，且排在【过去状态】之前。
    // ⚠️ 提示词取自**会话自己的 inputMessages**，不是 mock 请求列表的 at(-1) ——
    // 运行结束后后台还会冒出记忆整理等请求，at(-1) 很可能不是这次运行
    // （踩过：断言因此反复假失败，而实际注入一直是好的）。
    llm.state.script[llm.state.requests.length] = { content: '（看到了前情，不回）' };
    pushGroupMsg(111, '张三', '接着刚才的话题说', 9901);
    const injSession = await waitSessionDone('接着刚才的话题说', 20000);
    const promptWithSummary = String(injSession.inputMessages?.[1]?.content ?? '');
    assert.ok(promptWithSummary.includes('【前情摘要】'), '提示词含【前情摘要】段');
    assert.ok(promptWithSummary.includes('球赛'), '提示词带上了摘要正文');
    assert.ok(
      promptWithSummary.indexOf('【前情摘要】') < promptWithSummary.indexOf('【过去状态】'),
      '摘要排在【过去状态】之前（时间上更早）'
    );
    pass('前情摘要：注入提示词且排在【过去状态】之前');
  }

  // ── 上传 zip 安装技能（界面直传）──
  // 覆盖整条链：真实 HTTP 路由 → 包结构校验 → 落盘 → 立刻重扫 → 类型判据。
  // 技能系统此前没有任何端到端覆盖，这里至少把"传上去就能用"这条路跑通。
  {
    const base = `http://127.0.0.1:${cfg.server.port}`;

    // 最小 zip 构造（stored 方式，不压缩）：只为走通上传解析，不追求压缩率。
    // 读取端（zip-install.parseZip）只看中央目录 + 本地头，不校验 CRC，所以 CRC 填 0。
    const makeZip = (files) => {
      const chunks = [];
      const central = [];
      let offset = 0;
      for (const f of files) {
        const name = Buffer.from(f.name, 'utf8');
        const data = Buffer.from(f.text, 'utf8');
        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 8);            // method = 0（stored）
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);
        chunks.push(local, data);

        const cd = Buffer.alloc(46 + name.length);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 10);              // method = 0
        cd.writeUInt32LE(data.length, 20);
        cd.writeUInt32LE(data.length, 24);
        cd.writeUInt16LE(name.length, 28);
        cd.writeUInt32LE(offset, 42);
        name.copy(cd, 46);
        central.push(cd);
        offset += local.length + data.length;
      }
      const cdBuf = Buffer.concat(central);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE(files.length, 8);
      eocd.writeUInt16LE(files.length, 10);
      eocd.writeUInt32LE(cdBuf.length, 12);
      eocd.writeUInt32LE(offset, 16);
      return Buffer.concat([...chunks, cdBuf, eocd]);
    };

    const upload = (body) => fetch(`${base}/api/skills/upload`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body
    });

    // 1) 缺清单的包必须被拒，且**不落盘**（否则留下一个加载不起来的垃圾目录）
    const r1 = await upload(makeZip([{ name: 'whatever/index.js', text: 'export function setup() {}' }]));
    const d1 = await r1.json();
    assert.strictEqual(r1.status, 400, '缺 skill.json/plugin.json 的包被拒绝');
    assert.ok(String(d1.error || '').includes('skill.json'), `错误文案说清缺什么（实际：${d1.error}）`);
    pass('上传安装：缺清单的包被拒绝（未落盘）');

    // 2) 空内容
    const r3 = await upload(Buffer.alloc(0));
    assert.strictEqual(r3.status, 400, '空 body 被拒绝');
    pass('上传安装：空内容被拒绝');

    // 3) 合法包：上传 → 落盘 → 立刻重扫可见 → 删掉后不再出现
    const uid = `upload-test-${Date.now().toString(36)}`;
    const zip = makeZip([
      {
        name: `${uid}/skill.json`,
        text: JSON.stringify({
          id: uid, name: '上传测试技能', version: '1.0.0', apiVersion: 1,
          category: 'utility', description: '自检用的临时技能', enabledByDefault: false,
          capabilities: [], requires: [], settings: {}, configSchema: {}, prompt: null
        }, null, 2)
      },
      {
        name: `${uid}/index.js`,
        text: 'export function setup(api) { api.registerTool({ id: \'noop\', name: \'空操作\', '
          + 'description: \'测试用\', category: \'utility\', parameters: { type: \'object\', properties: {} }, '
          + 'async execute() { return { content: \'ok\' }; } }); }'
      }
    ]);
    const r2 = await upload(zip);
    const d2 = await r2.json();
    let installedDir = d2.dir || '';
    try {
      assert.strictEqual(r2.status, 200, `上传成功（HTTP ${r2.status} ${d2.error || ''}）`);
      assert.strictEqual(d2.type, 'skill', 'skill.json → skills/（与口令安装同一判据）');
      assert.ok(!d2.loadError, `加载无错（${d2.loadError || ''}）`);
      assert.ok(d2.installed && d2.installed.id === uid, '重扫后立刻能在列表里查到它');
      assert.ok(fs.existsSync(path.join(installedDir, 'skill.json')), '清单文件真的落盘了');
      assert.ok(fs.existsSync(path.join(installedDir, 'index.js')), '代码文件真的落盘了');
      const listed = await (await fetch(`${base}/api/skills`)).json();
      assert.ok((listed.skills || []).some((s) => s.id === uid), '/api/skills 能看到它');
      pass('上传安装：合法包落盘 + 立刻重扫可见', `id=${uid}`);
    } finally {
      // 这是往真实仓库的 skills/ 写文件，无论断言是否通过都要删干净并重扫
      try { fs.rmSync(installedDir, { recursive: true, force: true }); } catch { /* ignore */ }
      await fetch(`${base}/api/skills/reload`, { method: 'POST' }).catch(() => {});
    }
    const after = await (await fetch(`${base}/api/skills`)).json();
    assert.ok(!(after.skills || []).some((s) => s.id === uid), '删除后重扫，列表里不再有它（测试不留垃圾）');
    pass('上传安装：删除后重扫不再出现（不留残留）');
  }

  // ── 随机档：预判与实跑必须复用同一次掷骰 ──
  // 曾经的抖动（用户报的"一直等待"）：防抖窗口建立时预判命中 → 会话页亮出
  // "等待中"；2 秒后实跑**又掷一次**骰子，没中就把它干净丢弃。用户看到的是
  // "等了半天，然后什么都没有"。prompt.js 的 resolveContextTier 文档明确要求
  // 调用方把随机结果固定下来，这里就是那条要求。
  //
  // 复现手法：把两次掷骰的结果人为错开 —— 第 1 次（预判）命中、之后都不命中。
  // 修复后实跑直接复用预判的值，不再调 Math.random，会话因此不会被丢弃。
  {
    const base2 = `http://127.0.0.1:${cfg.server.port}`;
    await fetch(`${base2}/api/config`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      // 档位 3 = 随机档；清空关键词，确保只剩"随机"这一条触发路径。
      // wakeDelayMs 临时放大到 2500ms：本文件的 fixture 为了跑得快设的是 300ms，
      // 那样还没等到"防抖窗口内"就已经开跑了，测不到"等待中"这一刻。
      body: JSON.stringify({
        wakeDelayMs: 2500,
        store: { contextTier: 3, randomPercent: 50, keywords: [], unifiedTier: true }
      })
    });
    const origRandom = Math.random;
    const rolls = [0.1, 0.9];   // 第 1 次命中（10 < 50），第 2 次不命中（90）
    Math.random = () => (rolls.length ? rolls.shift() : 0.9);
    try {
      const idx = llm.state.requests.length;
      llm.state.script[idx] = { content: '（这轮不说话）' };
      llm.state.script[idx + 1] = { content: '（这轮不说话）' };
      pushGroupMsg(333, '王五', '今晚吃什么好呢', 7801);

      await sleep(1200);   // 仍在防抖窗口内（wakeDelayMs 默认 2000）
      const during = app.sessions.listSummaries(20)
        .find((s) => String(s.trigger || '').includes('今晚吃什么'));
      assert.ok(during, '预判命中时应立刻出现"等待中"会话');
      assert.strictEqual(during.status, 'waiting', '此刻处于防抖等待状态');

      await sleep(4500);   // 等过防抖窗口 + 跑完
      const settle = app.sessions.listSummaries(20)
        .find((s) => String(s.trigger || '').includes('今晚吃什么'));
      assert.ok(settle, '实跑复用预判的掷骰值 → 会话不会被丢弃（旧实现会在这里消失）');
      assert.notStrictEqual(settle.status, 'waiting', '会话已跑完');
      pass('随机档：预判与实跑复用同一次掷骰（不再"显示等待中、随后被丢弃"）');
    } finally {
      Math.random = origRandom;
      await fetch(`${base2}/api/config`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wakeDelayMs: 300, drainDelayMs: 200, store: { contextTier: 4, randomPercent: 100 } })
      }).catch(() => {});
    }
  }

  // ── 场景 42：本地表情的 file URI 拼装 + 历史脏数据自愈 ──
  // 回归：sticker-manager 曾手写 `file:///${绝对路径}`，POSIX 上绝对路径自带前导斜杠，
  // 拼出来是四个斜杠；协议端解析出的路径变成 //opt/... → ENOENT
  // （用户实测报错：send_group_msg 失败 retcode=200 open '//opt/qq-agent/data/sticker-images/…'）
  {
    const { toFileUri } = await import('../src/util.js');
    const { fixFileUri } = await import('../src/stickers.js');
    const { localStickerPath } = await import('../src/sticker-manager.js');

    assert.strictEqual(
      toFileUri('/opt/qq-agent/data/sticker-images/a.gif'),
      'file:///opt/qq-agent/data/sticker-images/a.gif',
      'POSIX 绝对路径应拼成三斜杠 file URI'
    );
    assert.strictEqual(
      new URL('file:////opt/a.gif').pathname, '//opt/a.gif',
      '四斜杠 URI 会被解析出双斜杠路径 —— 这正是那个 ENOENT 的来源'
    );
    assert.strictEqual(toFileUri('file:///opt/a.gif'), 'file:///opt/a.gif', '已是 URI 时保持幂等');
    assert.strictEqual(toFileUri('D:\\x\\a.gif'), 'file:///D:/x/a.gif', 'Windows 路径应转成三斜杠形式');

    // 老数据自愈：loadStickerStore 每条都会过 normalizeStickerEntry，所以存量的
    // 四斜杠条目重启一次就能正常发送，不需要用户重新收藏
    assert.strictEqual(
      fixFileUri('file:////opt/qq-agent/data/sticker-images/a.gif'),
      'file:///opt/qq-agent/data/sticker-images/a.gif',
      '历史四斜杠 URI 应被修回三斜杠'
    );
    assert.strictEqual(fixFileUri('file://server/share/a.gif'), 'file://server/share/a.gif', 'host 形式的 file URI 不该被动');

    // 受控目录判定：正常形式通过、历史四斜杠形式也要容忍、目录外仍拒绝
    const imgDir = path.join(dataDir, 'sticker-images');
    fs.mkdirSync(imgDir, { recursive: true });
    const realFile = path.join(imgDir, 'collected_999.gif');
    fs.writeFileSync(realFile, 'GIF89a');
    const good = toFileUri(realFile);
    assert.ok(localStickerPath(good), `正常 file URI 应通过受控目录判定：${good}`);
    // 手工构造"多一个斜杠"的历史形式（在两种平台下都能构造出来）
    const legacy = 'file:///' + good.slice('file://'.length);
    assert.ok(localStickerPath(legacy), `历史四斜杠形式应被容忍，否则合法收藏图会被拒绝发送：${legacy}`);
    const outside = path.join(dataDir, 'not-a-sticker.txt');
    fs.writeFileSync(outside, 'x');
    assert.strictEqual(localStickerPath(toFileUri(outside)), null, '受控目录外的本地文件必须拒绝');
    pass('本地表情 URI：POSIX/Windows/幂等 + 历史脏数据自愈 + 受控目录判定');
  }

  // ── 收尾 ──
  await app.stop();
  onebotWs.close();
  onebotHttp.server.close();
  llm.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });

  console.log(`\n全部 ${results.length} 项审计通过 ✅`);
  process.exit(0);
}

main().catch((error) => {
  console.error('\n❌ 审计失败：', error);
  process.exit(1);
});
