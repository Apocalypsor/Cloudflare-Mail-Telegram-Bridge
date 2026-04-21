import { MiniAppShell } from "@components/miniapp/layout";
import {
  ROUTE_MINI_APP_API_LIST,
  ROUTE_MINI_APP_API_MARK_ALL_READ,
  ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
  ROUTE_MINI_APP_MAIL,
} from "@handlers/hono/routes";
import type { MailListType } from "@services/mail-list";

const TITLES: Record<MailListType, string> = {
  unread: "📬 未读邮件",
  starred: "⭐ 星标邮件",
  junk: "🚫 垃圾邮件",
  archived: "📥 归档邮件",
};

interface BulkAction {
  label: string;
  url: string;
  confirmText: string;
  loadingText: string;
  /** 是否为破坏性操作（按钮显示成红色） */
  danger?: boolean;
}

const BULK_ACTIONS: Partial<Record<MailListType, BulkAction>> = {
  unread: {
    label: "✓ 全部已读",
    url: ROUTE_MINI_APP_API_MARK_ALL_READ,
    confirmText: "把所有未读邮件标记为已读？",
    loadingText: "标记中…",
  },
  junk: {
    label: "🗑 清空垃圾",
    url: ROUTE_MINI_APP_API_TRASH_ALL_JUNK,
    confirmText: "清空所有账号的垃圾邮件？此操作不可撤销。",
    loadingText: "清理中…",
    danger: true,
  },
};

const PAGE_CSS = `
.wrap { max-width: 720px; margin: 0 auto; padding: 16px; }
.head-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.head-actions { display: flex; gap: 8px; align-items: center; }
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
.bulk {
  padding: 6px 12px; border-radius: 16px;
  background: transparent;
  border: 1px solid var(--separator);
  color: var(--tg-theme-link-color, #60a5fa);
  font-size: 13px; line-height: 1.2; white-space: nowrap;
  cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.bulk.danger { color: var(--danger); border-color: rgba(239, 68, 68, .35); }
.bulk:active { opacity: .6; }
.bulk:disabled { opacity: .4; cursor: default; }
.meta { font-size: 13px; color: var(--hint); margin: 8px 0 12px; min-height: 18px; }
.meta.error { color: var(--danger); }
.meta.ok { color: #22c55e; }
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

function listScript(type: MailListType, bulk?: BulkAction): string {
  const bulkUrl = bulk ? JSON.stringify(bulk.url) : '""';
  const bulkLoading = bulk ? JSON.stringify(bulk.loadingText) : '""';
  const bulkConfirm = bulk ? JSON.stringify(bulk.confirmText) : '""';
  return `
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    if (tg.BackButton) tg.BackButton.hide();
  }
  var initData = (tg && tg.initData) || "";
  var TYPE = ${JSON.stringify(type)};
  var BULK_URL = ${bulkUrl};
  var BULK_LOADING = ${bulkLoading};
  var BULK_CONFIRM = ${bulkConfirm};
  // mail 页 folder hint：junk/archive 里的邮件不在 INBOX，IMAP 必须明确指定
  // 从哪个 folder 里按 Message-Id 搜（Gmail/Outlook 不读这个参数，无害）
  var FOLDER_HINT = TYPE === "junk" ? "junk" : TYPE === "archived" ? "archive" : "";
  var $ = function (id) { return document.getElementById(id); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function setMeta(text, kind) {
    var m = $("meta");
    m.textContent = text || "";
    m.className = "meta" + (kind ? " " + kind : "");
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
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) { renderError(res.data.error || "查询失败"); return; }
        render(res.data);
      })
      .catch(function () { renderError("网络错误"); })
      .finally(function () { if (btn) btn.classList.remove("spinning"); });
  }

  function render(data) {
    var c = $("content");
    c.innerHTML = "";

    if (!data.total) {
      c.appendChild(el("div", "empty", "暂无邮件"));
      // 列表为空时，meta 别留着 "成功 N 封" 这类残留消息盖住空状态
      if (!$("meta").className.match(/\\bok\\b|\\berror\\b/)) setMeta("");
      return;
    }
    setMeta("共 " + data.total + " 封");

    data.results.forEach(function (r) {
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
      hdr.appendChild(el("span", "count", String(r.total)));
      box.appendChild(hdr);

      r.items.forEach(function (it) {
        var row = el("div", "email");
        row.appendChild(el("div", "title", it.title || "(无主题)"));
        row.addEventListener("click", function () {
          openMail(it.id, r.accountId, it.token);
        });
        box.appendChild(row);
      });
      c.appendChild(box);
    });
  }

  function runBulk() {
    var btn = $("bulk");
    btn.disabled = true;
    setMeta(BULK_LOADING);
    fetch(BULK_URL, {
      method: "POST",
      headers: { "x-telegram-init-data": initData },
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, data: d }; }); })
      .then(function (res) {
        if (!res.ok) {
          setMeta((res.data && res.data.error) || "操作失败", "error");
          return;
        }
        var s = res.data.success || 0;
        var f = res.data.failed || 0;
        var msg = "✅ 成功 " + s + " 封" + (f > 0 ? "，❌ " + f + " 封失败" : "");
        setMeta(msg, "ok");
        if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(f > 0 ? "warning" : "success");
        load(true);
      })
      .catch(function () { setMeta("网络错误", "error"); })
      .finally(function () { btn.disabled = false; });
  }

  function confirmThen(text, fn) {
    if (tg && tg.showConfirm) tg.showConfirm(text, function (ok) { if (ok) fn(); });
    else if (confirm(text)) fn();
  }

  var refreshBtn = $("refresh");
  if (refreshBtn) refreshBtn.addEventListener("click", function () { load(true); });
  var bulkBtn = $("bulk");
  if (bulkBtn) bulkBtn.addEventListener("click", function () { confirmThen(BULK_CONFIRM, runBulk); });
  load(false);
})();
`.trim();
}

export function MiniAppMailListPage({ type }: { type: MailListType }) {
  const bulk = BULK_ACTIONS[type];
  return (
    <MiniAppShell title={`${TITLES[type]} — Telemail`} extraCss={PAGE_CSS}>
      <div class="wrap">
        <div class="head-row">
          <h1>{TITLES[type]}</h1>
          <div class="head-actions">
            {bulk && (
              <button
                id="bulk"
                type="button"
                class={`bulk ${bulk.danger ? "danger" : ""}`}
              >
                {bulk.label}
              </button>
            )}
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
        </div>
        <div id="meta" class="meta" />
        <div id="content">
          <div class="loading">加载中…</div>
        </div>
      </div>
      <script dangerouslySetInnerHTML={{ __html: listScript(type, bulk) }} />
    </MiniAppShell>
  );
}
