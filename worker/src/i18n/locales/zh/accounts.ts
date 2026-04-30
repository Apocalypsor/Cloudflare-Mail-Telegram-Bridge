export default {
  list: {
    myAccounts: "📧 我的账号 ({{count}})",
    noAccounts: "📧 暂无账号",
    allAccounts: "📧 所有账号 ({{count}})",
    addAccount: "➕ 添加账号",
    collapse: "🔽 收起",
    viewAll: "👀 查看所有账号",
  },
  detail: {
    title: "📧 账号详情 #{{id}}",
    typeLabel: "类型: {{type}}",
    email: "邮箱: {{email}}",
    server: "服务器: {{server}}",
    username: "用户名: {{user}}",
    status: "状态: {{status}}",
    owner: "所有者: {{name}}",
  },
  button: {
    edit: "✏️ 编辑",
    delete: "❌ 删除",
    reauthorize: "🔑 重新授权",
    authorize: "🔑 授权",
    clickAuth: "🔗 点击授权",
    clickAuthProvider: "🔗 点击授权 {{provider}}",
    disable: "⏸ 禁用",
    enable: "▶ 启用",
  },
  disabled: {
    toggledOn: "⏸ 账号已禁用，新邮件将暂停转发",
    toggledOff: "▶ 账号已启用",
  },
  add: {
    promptChatId:
      "➕ 添加账号\n\n请发送 Chat ID（数字），或点击下方按钮使用当前会话 ID：",
    useCurrent: "📌 使用当前 Chat ID ({{id}})",
    selectType: "选择账号类型：",
    selectTypePrompt: "➕ 添加账号\n\nChat ID: {{chatId}}\n\n选择账号类型：",
    gmail: "📨 Gmail (OAuth)",
    outlook: "📮 Outlook (OAuth)",
    imap: "📬 IMAP",
    notConfigured: "❌ {{provider}} OAuth 未配置，请联系管理员",
    imapNotConfigured: "❌ IMAP 中间件未配置，请联系管理员",
    oauthCreated:
      "✅ {{type}} 账号已创建 #{{id}}\n\nChat ID: {{chatId}}\n\n请点击下方按钮完成 {{provider}} 授权：",
  },
  imap: {
    promptHost:
      "📬 添加 IMAP 账号\n\nChat ID: {{chatId}}\n\n请发送 IMAP 服务器地址（如 imap.gmail.com）：",
    promptPort:
      "服务器: {{host}}\n\n请发送 IMAP 端口（如 993 for TLS，143 for STARTTLS）：",
    promptSecure: "服务器: {{server}}\n\n是否使用 TLS/SSL 加密？",
    promptUser:
      "📬 添加 IMAP 账号\n\n服务器: {{server}}\n\n请发送 IMAP 用户名（通常为邮箱地址）：",
    promptPass: "请发送 IMAP 密码：",
    secureYes: "✅ 是（TLS/SSL）",
    secureNo: "❌ 否",
    noTls: "无 TLS",
    created:
      "✅ IMAP 账号已创建 #{{id}}\n\n邮箱: {{email}}\nChat ID: {{chatId}}",
  },
  oauth: {
    prompt:
      "🔑 {{provider}} OAuth 授权\n\n账号: {{account}}\n\n请点击下方按钮完成 {{provider}} 授权：",
    imapNoOAuth: "IMAP 账号不需要 OAuth 授权",
    notAuthorized: "账号未授权",
    watchRenewed: "✅ Watch 已续订: {{email}}",
    watchFailed: "❌ Watch 续订失败",
  },
  delete: {
    confirm:
      "⚠️ 确认删除账号 #{{id}}?\n\n邮箱: {{email}}\nChat ID: {{chatId}}\n\n此操作不可撤销。",
    deleted: "✅ 账号 #{{id}} 已删除\n\n📧 我的账号 ({{count}})",
  },
  edit: {
    title: "✏️ 编辑账号 #{{id}}",
    selectItem: "选择要编辑的项目：",
    chatId: "✏️ 编辑 Chat ID",
    chatIdPrompt:
      "✏️ 编辑 Chat ID\n\n当前值: {{current}}\n\n请发送新的 Chat ID：",
    chatIdUpdated: "✅ Chat ID 已更新为 {{value}}",
    assignOwner: "👤 分配所有者",
    ownerTitle:
      "👤 分配所有者\n\n账号 #{{id}}\n当前所有者: {{current}}\n\n选择新的所有者：",
    ownerCurrent: " (当前)",
    ownerAssigned: "✅ 已分配给 {{owner}}",
  },
  input: {
    chatIdMustBeNumber: "❌ Chat ID 必须为数字，请重新发送：",
    hostEmpty: "❌ 服务器地址不能为空，请重新发送：",
    portInvalid: "❌ 端口必须为 1–65535 之间的数字，请重新发送：",
    userEmpty: "❌ 用户名不能为空，请重新发送：",
    passEmpty: "❌ 密码不能为空，请重新发送：",
  },
};
