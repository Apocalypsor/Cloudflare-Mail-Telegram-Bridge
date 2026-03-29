export default {
  querying: "🔍 正在查询{{label}}邮件…",
  queryingShort: "正在查询…",
  total: "{{icon}} 共 {{total}} 封{{label}}",
  accountLabel: "📧 {{label}} ({{count}} 封{{type}})",
  tgMessage: "💬 消息",
  preview: "👁 预览",
  unread: {
    icon: "📬",
    label: "未读",
    empty: "✅ 所有邮箱都没有未读邮件",
    markAllRead: "✉️ 标记全部已读",
    marking: "正在标记…",
    markResult: "✅ 已标记 {{success}} 封已读",
    markResultWithFailed: "✅ 已标记 {{success}} 封已读，{{failed}} 封失败",
  },
  starred: {
    icon: "⭐",
    label: "星标",
    empty: "✅ 没有星标邮件",
  },
  junk: {
    icon: "🚫",
    label: "垃圾",
    empty: "✅ 没有垃圾邮件",
    deleteAll: "🗑 全部删除",
    deleting: "正在删除…",
    deleteResult: "🗑 已删除 {{success}} 封垃圾邮件",
    deleteResultWithFailed:
      "🗑 已删除 {{success}} 封垃圾邮件，{{failed}} 个账号失败",
  },
};
