// 工作记忆：像内存 / 剪贴板。
// 一次「运行」里正在用的碎片：触发消息、刚检索到的长时片段、草稿结论。
// 容量小；会话结束即清空（打断易丢）。
const MAX_ITEMS = 24;
const MAX_CHARS = 3500;

export class WorkingMemory {
  constructor() {
    /** @type {{kind:string, at:number, text:string, meta?:object}[]} */
    this.items = [];
  }

  /** 放入一条工作碎片（触发/检索结果/结论）。 */
  hold(kind, text, meta = null) {
    const t = String(text ?? '').slice(0, 1200);
    if (!t) return null;
    const item = { kind: String(kind || 'note'), at: Date.now(), text: t, meta };
    this.items.push(item);
    this.#trim();
    return item;
  }

  /** 检索结果批量放入。 */
  holdHits(hits) {
    for (const h of hits || []) {
      this.hold('recall', h.snippet || h.text || '', {
        when: h.when, score: h.score, chunkId: h.chunkId, chatKey: h.chatKey
      });
    }
  }

  /** 拼成给模型看的一小段「你现在记得」。 */
  render({ maxItems = 12 } = {}) {
    const list = this.items.slice(-Math.max(1, maxItems));
    if (!list.length) return '';
    const lines = list.map((x) => {
      const when = x.meta?.when ? ` @${x.meta.when}` : '';
      return `- [${x.kind}${when}] ${x.text}`;
    });
    return `【工作记忆·临时】\n${lines.join('\n')}`;
  }

  clear() {
    this.items = [];
  }

  #trim() {
    while (this.items.length > MAX_ITEMS) this.items.shift();
    let total = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      total += this.items[i].text.length;
      if (total > MAX_CHARS) {
        this.items = this.items.slice(i + 1);
        break;
      }
    }
  }
}
