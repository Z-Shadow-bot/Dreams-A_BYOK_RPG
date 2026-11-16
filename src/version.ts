// 应用版本号与更新日志（发版时在此维护）
export const APP_VERSION = '1.1.0'

export interface ChangelogEntry {
  version: string
  date: string
  items: string[]
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.1.0',
    date: '2026-11-16',
    items: [
      '世界书条目支持内容级增量更新（追加/删除行/整段替换），减少重复输出、节省 token 并提升稳定性',
      '世界书条目超过阈值时自动压缩（独立请求，可在「我的-上下文设置」调整阈值，0 为关闭）',
      '深度思考模式下自动移除推理模型不支持的 temperature / response_format，避免 400',
      '导入世界支持同 id 更新/新建，作者更新世界后可再次分享给他人更新',
      '冒险页点击行动选项改为复制到输入框，可修改后再发送',
      '状态-概述支持本地改写（开启后双击条目编辑）',
      '修复多 BGM 随机场景在状态页/冒险页切换时被重新随机的问题',
      '长冒险分页懒加载，页面数量多时更流畅',
      '清理无用代码；新增发布脚本',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-10-23',
    items: ['首个正式版本：世界创建、DLC 导入、文字冒险、存档、状态面板'],
  },
]
