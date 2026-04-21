export default {
  menu: {
    title: "⚙️ 全局操作",
  },
  users: {
    noUsers: "👥 暂无用户",
    title: "👥 用户列表 ({{count}})",
    revoke: "撤回",
    approve: "批准",
    confirmDelete:
      "确定要删除用户 {{name}} 吗？\n\n该用户关联的账号绑定将被解除。",
    deleted: "🗑 已删除",
    processed: "已处理",
  },
  watch: {
    renewing: "⏳ 正在续订...",
    renewed: "⚙️ 全局操作\n\n✅ 所有 Watch 已续订",
    failed: "⚙️ 全局操作\n\n❌ Watch 续订失败",
  },
  failedEmails: {
    title: "📋 失败邮件",
    titleWithCount: "📋 失败邮件 ({{count}})",
    noRecords: "📋 失败邮件\n\n暂无记录",
    retrying: "⏳ 正在重试...",
    retryResult: "✅ {{success}} 封成功",
    retryResultWithFailed: "✅ {{success}} 封成功，❌ {{failed}} 封仍失败",
    retryError: "📋 失败邮件\n\n❌ 重试出错",
    refreshList: "📋 刷新列表",
    retryAll: "🔄 全部重试",
    clearAll: "🗑 全部清空",
    cleared: "📋 失败邮件\n\n✅ 已全部清空",
    clearedShort: "已清空",
  },
  renewWatch: "🔄 续订所有 Watch",
  htmlPreview: "🔍 HTML 预览工具",
  junkCheck: "🚫 垃圾邮件检测",
  secrets: {
    privateOnly: "/secrets 仅限私聊使用（避免在群里泄漏）",
    title: "🔑 Secrets",
    webhookUrlLabel: "Webhook URL（直接 setWebhook 用）",
  },
};
