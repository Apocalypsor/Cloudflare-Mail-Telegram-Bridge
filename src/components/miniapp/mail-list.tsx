import { MINIAPP_BASE_CSS } from "@components/miniapp/styles";
import {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_MAIL,
} from "@handlers/hono/routes";
import type { MailListType } from "@services/mail-list";

const TITLES: Record<MailListType, string> = {
  unread: "📬 未读邮件",
  starred: "⭐ 星标邮件",
  junk: "🚫 垃圾邮件",
  archived: "📥 归档邮件",
};

const PAGE_CSS = `${MINIAPP_BASE_CSS}
.wrap { max-width: 720px; margin: 0 auto; padding: 16px; }
.head-row { display: flex; justify-content: space-between; align-items: center; }
h1 { font-size: 20px; font-weight: 600; margin: 4px 0; }
.refresh {
  width: 32px; height: 32px; padding: 0;
  display: flex; align-items: center; justify-content: center;
  border-radius: 50%; background: transparent;
  border: 1px solid var(--separator);
  color: var(--tg-theme-link-color, #60a5fa);
  font-size: 18px; line-height: 1;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.refresh:active { opacity: .6; }
.refresh.spinning { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.meta { font-size: 13px; color: var(--hint); margin: 8px 0 12px; }
.account { background: var(--surface); border-radius: 14px; padding: 6px 0; margin-bottom: 14px; overflow: hidden; }
.account-header {
  padding: 10px 14px; font-size: 13px; color: var(--hint);
  display: flex; justify-content: space-between; align-items: center;
}
.account-header .count { color: var(--link); font-weight: 600; }
.account-header.error { color: var(--danger); }
.email {
  padding: 12px 14px; cursor: pointer; border-top: 1px solid var(--separator);
  transition: background .1s;
}
.email:active { background: var(--separator); }
.email .title { font-size: 14px; word-break: break-word; }
.empty, .loading, .fatal {
  text-align: center; padding: 28px 16px; color: var(--hint); font-size: 14px;
}
.fatal { color: var(--danger); }
`;

function listScript(type: MailListType): string {
  return `
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    if (tg.BackButton) tg.BackButton.hide();
  }
  var initData = (tg && tg.initData) || "";
  var TYPE = ${JSON.stringify(type)};
  // mail 页 folder hint：junk/archive 里的邮件不在 INBOX，IMAP 必须明确指定
  // 从哪个 folder 里按 Message-Id 搜（Gmail/Outlook 不读这个参数，无害）
  var FOLDER_HINT = TYPE === "junk" ? "junk" : TYPE === "archived" ? "archive" : "";
  var $ = function(id){ return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function renderError(msg) {
    var c = $("content");
    c.innerHTML = "";
    c.appendChild(el("div", "fatal", msg));
  }

  function openMail(id, accountId, token) {
    var back = encodeURIComponent(location.pathname + location.search);
    location.href = "${ROUTE_MINI_APP_MAIL.replace(":id", "")}" + encodeURIComponent(id)
      + "?accountId=" + accountId + "&t=" + encodeURIComponent(token)
      + (FOLDER_HINT ? "&folder=" + FOLDER_HINT : "")
      + "&back=" + back;
  }

  function load(force) {
    var btn = $("refresh");
    if (btn) btn.classList.add("spinning");
    var url = "${ROUTE_MINI_APP_API_LIST.replace(":type", "")}" + TYPE
      + (force ? "" : "?cache=true");
    fetch(url, { headers: { "x-telegram-init-data": initData } })
      .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d }; }); })
      .then(function(res){
        if (!res.ok) { renderError(res.data.error || "查询失败"); return; }
        render(res.data);
      })
      .catch(function(){ renderError("网络错误"); })
      .finally(function(){
        if (btn) btn.classList.remove("spinning");
      });
  }

  function render(data) {
    var c = $("content");
    c.innerHTML = "";

    if (!data.total) {
      c.appendChild(el("div", "empty", "暂无邮件"));
      return;
    }
    $("meta").textContent = "共 " + data.total + " 封";

    data.results.forEach(function(r){
      if (r.error) {
        var box = el("div", "account");
        var hdr = el("div", "account-header error");
        hdr.appendChild(el("span", null, r.accountEmail || ("Account #" + r.accountId)));
        hdr.appendChild(el("span", null, "查询失败"));
        box.appendChild(hdr);
        c.appendChild(box);
        return;
      }
      if (!r.total) return;

      var box = el("div", "account");
      var hdr = el("div", "account-header");
      hdr.appendChild(el("span", null, r.accountEmail || ("Account #" + r.accountId)));
      var cnt = el("span", "count", String(r.total));
      hdr.appendChild(cnt);
      box.appendChild(hdr);

      r.items.forEach(function(it){
        var row = el("div", "email");
        row.appendChild(el("div", "title", it.title || "(无主题)"));
        row.addEventListener("click", function(){
          openMail(it.id, r.accountId, it.token);
        });
        box.appendChild(row);
      });
      c.appendChild(box);
    });
  }

  var refreshBtn = $("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function(){ load(true); });
  load(false);
})();
`;
}

export function MiniAppMailListPage({ type }: { type: MailListType }) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>{TITLES[type]} — Telemail</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script src="https://telegram.org/js/telegram-web-app.js" />
        <style dangerouslySetInnerHTML={{ __html: PAGE_CSS }} />
      </head>
      <body>
        <div class="wrap">
          <div class="head-row">
            <h1>{TITLES[type]}</h1>
            <button
              id="refresh"
              type="button"
              class="refresh"
              title="强制刷新"
              aria-label="强制刷新"
            >
              ↻
            </button>
          </div>
          <div id="meta" class="meta" />
          <div id="content">
            <div class="loading">加载中…</div>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: listScript(type) }} />
      </body>
    </html>
  );
}
