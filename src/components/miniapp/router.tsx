import {
  ROUTE_MINI_APP_MAIL,
  ROUTE_MINI_APP_REMINDERS,
  ROUTE_REMINDERS_API_RESOLVE_CONTEXT,
} from "@handlers/hono/routes";

/**
 * Mini App 入口路由页：群聊 deep link 唯一能落到的 URL
 * （BotFather `/newapp` 注册的就是这里）。读 `start_param` 前缀决定跳哪去：
 *   r_<chatId>_<tgMsgId>  → 提醒页
 *   m_<chatId>_<tgMsgId>  → 邮件预览页
 *   <chatId>_<tgMsgId>    → 提醒页（兼容旧按钮）
 *   无 start_param         → 提醒页（默认）
 *
 * 私聊场景的 `web_app` 按钮直接跳子页面 URL，不会经过这里。
 */
function routerScript(): string {
  return `
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    if (tg.BackButton) tg.BackButton.hide();
  }
  var initData = (tg && tg.initData) || "";
  var sp = (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) || "";

  function fail(msg) {
    document.body.innerHTML = '<p style="padding:20px;color:#ef4444;">' + msg + '</p>';
  }

  // 没 start_param → 默认到提醒页
  if (!sp) {
    location.replace("${ROUTE_MINI_APP_REMINDERS}");
    return;
  }

  // 解析 [<feature>_]<chatId>_<tgMsgId>
  var m = sp.match(/^(?:([a-z])_)?(-?\\d+)_(\\d+)$/);
  if (!m) {
    fail("无效的入口参数");
    return;
  }
  var feature = m[1] || "r";  // 默认 r（兼容旧无前缀按钮）
  var chatId = m[2];
  var tgMsgId = m[3];

  fetch("${ROUTE_REMINDERS_API_RESOLVE_CONTEXT}?start=" + encodeURIComponent(chatId + "_" + tgMsgId), {
    headers: { "x-telegram-init-data": initData },
  })
  .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
  .then(function(res){
    if (!res.ok) { fail(res.data.error || "无法打开"); return; }
    var d = res.data;
    if (feature === "m") {
      location.replace("${ROUTE_MINI_APP_MAIL.replace(":id", "")}" + encodeURIComponent(d.messageId)
        + "?accountId=" + d.accountId + "&t=" + encodeURIComponent(d.token));
    } else {
      location.replace("${ROUTE_MINI_APP_REMINDERS}?accountId=" + d.accountId
        + "&messageId=" + encodeURIComponent(d.messageId)
        + "&token=" + encodeURIComponent(d.token));
    }
  })
  .catch(function(){ fail("网络错误"); });
})();
`;
}

export function MiniAppRouterPage() {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>Telemail</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </head>
      <body
        style={`background: var(--tg-theme-bg-color, #0f172a); color: var(--tg-theme-text-color, #e2e8f0); font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;`}
      >
        <p style="padding:20px;color:var(--tg-theme-hint-color,#94a3b8);">
          加载中…
        </p>
        <script dangerouslySetInnerHTML={{ __html: routerScript() }} />
      </body>
    </html>
  );
}
