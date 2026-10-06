// 图片发送回退链测试。
//
// 真实故障（用户报错）：文生图把图落到**机器人自己的** tmpdir
// （报错里是 /tmp/qq-agent-image-generate/gen-….jpg），协议端在另一个文件系统里
// （Docker / 另一台机器 / 另一个盘），于是 `send_private_msg 失败: retcode=200
// ENOENT … open '/tmp/…'`。而 sendImage 当时只认"调用方另外备了 dataUrl"这一种
// 回退 —— 文生图/图搜/媒体下载这些链路手里**只有本地路径**，于是"图画出来了却发
// 不出去"成了死路（表情那条链早就修过同款问题，图片漏了）。
//
// 这里用一个"只认 base64"的假协议端复现那个场景，断言回退链真的能把图送出去。
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-img-fallback-'));
process.env.QQ_AGENT_DATA_DIR = TMP;

const { SendQueue } = await import('../src/sender.js');
const { ChatStore } = await import('../src/store.js');
const { setRuntimeConfig, DEFAULT_CONFIG } = await import('../src/config.js');
const { toFileUri, fromFileUri } = await import('../src/util.js');

const cfg = structuredClone(DEFAULT_CONFIG);
cfg.send.dedupeWindowMs = 0;      // 关掉发送去重，否则"同一张图重发"会被挡
cfg.send.minGapMs = 200;          // 发送前的拟人停顿压到最小，别让测试白等
cfg.send.maxGapMs = 200;
setRuntimeConfig(cfg);

let passed = 0;
function ok(cond, label) {
  assert.ok(cond, label);
  passed += 1;
}

// 造一张"真图"：内容不重要，只要求是非空文件、能逐字节比对
const imgPath = path.join(TMP, 'gen-test.jpg');
const imgBytes = Buffer.from('fake-jpeg-bytes-0123456789');
fs.writeFileSync(imgPath, imgBytes);

/** 假协议端：accept(ref) 为假就抛 ENOENT（模拟协议端看不到机器人文件系统）。 */
function fakeOneBot(accept) {
  const calls = [];
  return {
    calls,
    async sendImage(kind, id, ref) {
      calls.push({ kind, id, ref });
      if (!accept(String(ref))) {
        throw new Error(`OneBot send_private_msg 失败: retcode=200 ENOENT: no such file or directory, open '${fromFileUri(ref)}'`);
      }
      return { message_id: 999 };
    }
  };
}
const isBase64 = (ref) => String(ref).startsWith('base64://');
const isFileUri = (ref) => String(ref).startsWith('file:///');

// ── 1. 协议端读不到本地路径（文生图的真实场景）→ 机器人自己读盘转 base64 ──
{
  const onebot = fakeOneBot(isBase64);
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await q.sendImage('private:10001', { file: imgPath });
  ok(onebot.calls.length === 2, `先走 file:// 失败、再回退重发（实际 ${onebot.calls.length} 次调用）`);
  ok(isFileUri(onebot.calls[0].ref), `第一次用 file:// URI（同机时最快）：${onebot.calls[0].ref.slice(0, 24)}…`);
  ok(isBase64(onebot.calls[1].ref), '第二次用 base64:// 内联');
  const decoded = Buffer.from(String(onebot.calls[1].ref).slice('base64://'.length), 'base64');
  ok(decoded.equals(imgBytes), '回退发出的字节与磁盘上的图逐字节一致');
}

// ── 2. 调用方自带 dataUrl → 优先用它，不去读盘 ──
{
  const onebot = fakeOneBot((r) => r === 'base64://QUJD');
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await q.sendImage('private:10002', { file: imgPath, dataUrl: 'base64://QUJD' });
  ok(onebot.calls.length === 2 && onebot.calls[1].ref === 'base64://QUJD', '调用方给了 dataUrl 就照用（原有行为不变）');
}

// ── 3. 文件根本不在（被清理 / 路径本身就错）→ 报人话，不把裸 ENOENT 丢给模型 ──
{
  const onebot = fakeOneBot(() => false);
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await assert.rejects(
    () => q.sendImage('private:10003', { file: path.join(TMP, 'not-exist.jpg') }),
    (error) => {
      ok(/图片发送失败/.test(error.message), `报错说明了是"发图失败"：${error.message.slice(0, 40)}…`);
      ok(/机器人侧也读不到/.test(error.message), '点明"机器人侧也读不到这个文件"（区分于"只有协议端读不到"）');
      return true;
    }
  );
}

// ── 3b. 文件在、但协议端读不到、且回退也失败 → 区分两侧可见性，便于排查 ──
{
  const onebot = fakeOneBot(() => false);
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await assert.rejects(
    () => q.sendImage('private:10006', { file: imgPath, dataUrl: 'base64://QUJD' }),
    (error) => {
      ok(/仍发送失败/.test(error.message), `内联仍失败时明确说是"改用 base64 后仍失败"：${error.message.slice(0, 40)}…`);
      return true;
    }
  );
}

// ── 4. 同机协议端（能读路径）→ 一次成功、不做多余回退（base64 明显更慢）──
{
  const onebot = fakeOneBot(isFileUri);
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await q.sendImage('private:10004', { file: imgPath });
  ok(onebot.calls.length === 1, '协议端读得到路径时只调用一次');
}

// ── 5. 超过内联上限 → 明确报"超过内联上限"，而不是含糊地再失败一次 ──
{
  const bigPath = path.join(TMP, 'big.jpg');
  fs.writeFileSync(bigPath, Buffer.alloc(11 * 1024 * 1024, 1));
  const onebot = fakeOneBot(isBase64);
  const q = new SendQueue({ onebot, store: new ChatStore(0), log: () => {} });
  await assert.rejects(
    () => q.sendImage('private:10005', { file: bigPath }),
    (error) => {
      ok(/超过内联上限/.test(error.message), `超限给的是可读错误：${error.message.slice(0, 42)}…`);
      return true;
    }
  );
}

// ── 6. fromFileUri 与 toFileUri 互逆（POSIX / Windows / 四斜杠脏数据 / UNC / 裸路径）──
{
  ok(fromFileUri(toFileUri('/opt/my images/鲸鱼.jpg')) === '/opt/my images/鲸鱼.jpg', 'POSIX 含空格与中文的路径往返一致');
  ok(fromFileUri('file:///D:/x/y.jpg') === 'D:/x/y.jpg', 'Windows 的多余前导斜杠被去掉');
  ok(fromFileUri('file:////opt/x.gif') === '/opt/x.gif', '历史四斜杠脏数据被收敛（别再演一次那个 bug）');
  ok(fromFileUri('file://server/share/a.jpg') === '//server/share/a.jpg', 'UNC host 形式保留 server');
  ok(fromFileUri('C:/plain/path.jpg') === 'C:/plain/path.jpg', '裸路径原样返回');
  ok(fromFileUri('') === '', '空值返回空串（调用方据此走报错分支）');
}

// ── 7. 文生图的临时产物必须是绝对路径（否则机器人与协议端可能各解析到不同盘）──
{
  const skill = await import('../skills/image-generate/index.js');
  const p = skill.internals.tempImagePath('.jpg');
  ok(path.isAbsolute(p), `临时路径是绝对的：${p}`);
  ok(p.startsWith(path.resolve(os.tmpdir())), '仍在系统临时目录下（位置没变，只是钉成绝对路径）');
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`✓ 图片发送回退链全部通过（${passed} 项断言）`);
