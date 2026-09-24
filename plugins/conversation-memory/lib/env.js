// 数据根目录：**必须**与正在运行的那份进程完全一致。
//
// 为什么不自己算：DATA_DIR 由 QQ_AGENT_DATA_DIR（显式覆盖）> QQ_AGENT_PROFILE（多实例
// 推导 data-2/）> 默认 data/ 三层决定。插件若自己拼一遍，多实例下就会算错根目录 ——
// 表现是"实例 #2 的记忆写进了 #1 的目录"，两个机器人的记忆互相污染，且极难发现。
// 所以这里直接复用核心的导出，唯一真源。
//
// lib/ → conversation-memory/ → plugins/ → 仓库根
export { DATA_DIR, ROOT } from '../../../src/config.js';
