// 模型工具定义：只在调用时才查长时（平常零成本）。
// 不自动塞进主工程 tools.js —— 接线时再 register。
import { Consolidator } from './consolidator.js';
import { SensoryBuffer } from './sensory.js';
import { WorkingMemory } from './working.js';
import { ArchiveReader } from './archive.js';

/**
 * @param {{ messagesDir: string, memoryRoot: string }} paths
 */
export function createConversationMemory(paths) {
  const consolidator = new Consolidator(paths);
  const sensory = new SensoryBuffer();
  const working = new WorkingMemory();
  const archive = new ArchiveReader({ messagesDir: paths.messagesDir });

  return {
    consolidator,
    sensory,
    working,
    archive,

    /** 消息进来时调用：感知 + 排队巩固。 */
    onMessage(chatKey, msg) {
      sensory.perceive(chatKey, msg);
      working.hold('sense', String(msg.text || '').slice(0, 160), {
        who: msg.senderName || msg.senderId
      });
    },

    /** 运行开始：把未读/触发批写入工作记忆。 */
    beginRun(triggerMsgs = []) {
      for (const m of triggerMsgs.slice(-12)) {
        working.hold('trigger', String(m.text || '').slice(0, 200), {
          who: m.senderName || m.senderId,
          when: m.ts
        });
      }
    },

    /** 模型调用 memory_search。 */
    search(query, opts = {}) {
      const hits = consolidator.search(query, opts);
      working.holdHits(hits);
      return hits;
    },

    /** 运行结束：清空工作记忆（打断易丢）。 */
    endRun() {
      working.clear();
    },

    /** 后台巩固（可定时）。 */
    consolidate(opts) {
      return consolidator.consolidateAll(opts);
    }
  };
}
