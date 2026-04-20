import { MINIAPP_BASE_CSS } from "@components/miniapp/styles";
import {
  ROUTE_MINI_APP_MAIL,
  ROUTE_REMINDERS_API,
  ROUTE_REMINDERS_API_EMAIL_CONTEXT,
} from "@handlers/hono/routes";

const REMINDERS_CSS = `${MINIAPP_BASE_CSS}
.wrap { max-width: 560px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; font-weight: 600; margin: 4px 0 16px; }
.section { background: var(--surface); border-radius: 14px; padding: 14px; margin-bottom: 14px; }
label, .section-title { display: block; font-size: 13px; color: var(--hint); margin-bottom: 6px; }
.email-card { padding: 12px 14px; border-left: 3px solid var(--button); background: var(--surface); border-radius: 8px; margin-bottom: 14px; cursor: pointer; transition: opacity .15s; }
.email-card:active { opacity: .65; }
.email-card .subject { font-size: 15px; font-weight: 600; word-break: break-word; }
.email-card .from { font-size: 12px; color: var(--hint); margin-top: 2px; }
.email-card .open-hint { font-size: 11px; color: var(--button); margin-top: 6px; }
input[type="text"], input[type="date"], input[type="time"], textarea {
  width: 100%; padding: 11px 12px; border-radius: 10px;
  border: 1px solid var(--border); background: var(--bg); color: var(--text);
  font-size: 15px; font-family: inherit; outline: none;
  -webkit-appearance: none; appearance: none; min-width: 0;
}
textarea { min-height: 70px; resize: vertical; }
input:focus, textarea:focus { border-color: var(--button); }
.when-row { display: flex; gap: 8px; }
.when-row input[type="date"] { flex: 1 1 auto; }
.when-row input[type="time"] { flex: 0 0 38%; }
.presets { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.preset {
  padding: 8px 12px; border-radius: 999px; border: 1px solid var(--border);
  background: transparent; color: var(--text); font-size: 13px; cursor: pointer;
}
.preset:active { background: var(--button); color: var(--button-text); }
.preset.active { background: var(--button); color: var(--button-text); border-color: var(--button); }
.btn-primary {
  width: 100%; padding: 13px; border: none; border-radius: 12px;
  background: var(--button); color: var(--button-text);
  font-size: 16px; font-weight: 600; cursor: pointer;
}
.btn-primary:disabled { opacity: .5; cursor: not-allowed; }
.status { margin-top: 10px; font-size: 13px; min-height: 18px; }
.status.error { color: var(--danger); }
.status.ok { color: #22c55e; }
.list { list-style: none; padding: 0; margin: 0; }
.list li {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 10px 0; border-bottom: 1px solid var(--border); gap: 10px;
}
.list li:last-child { border-bottom: 0; }
.list .meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.list .meta .when { font-size: 12px; color: var(--hint); margin-bottom: 2px; }
.list .meta .subject { font-size: 13px; color: var(--hint); margin-top: 2px; word-break: break-word; }
.list .meta .text { font-size: 14px; word-break: break-word; }
.list .del {
  background: transparent; border: none; color: var(--danger);
  font-size: 18px; cursor: pointer; padding: 4px 8px;
}
.empty, .fatal { color: var(--hint); font-size: 13px; padding: 6px 0; }
.fatal { color: var(--danger); }
.helper { color: var(--hint); font-size: 12px; margin-top: 6px; }
`;

function remindersScript(): string {
  return `
(function(){
  var tg = window.Telegram && window.Telegram.WebApp;
  if (tg) {
    tg.ready(); tg.expand();
    // 提醒是 root 页面，没有上级 —— 显式隐藏 BackButton 防止从 mail 页返回后
    // 残留可见状态（TG WebApp 的 BackButton state 跨页面持久化）。
    if (tg.BackButton) tg.BackButton.hide();
  }
  var initData = (tg && tg.initData) || "";

  var $ = function(id){ return document.getElementById(id); };
  var fmt2 = function(n){ return n < 10 ? "0" + n : "" + n; };

  // 两种模式：
  //  - 邮件模式：URL 带 (accountId, messageId, token) → 显示邮件卡 + 添加表单 + 列表
  //  - 列表模式：URL 无邮件三件套（如主菜单 ⏰ 我的提醒进入）→ 仅显示列表
  var qs = new URLSearchParams(location.search);
  var ctx = {
    accountId: Number(qs.get("accountId")),
    messageId: qs.get("messageId") || "",
    token: qs.get("token") || "",
  };
  var listOnly = !(ctx.accountId && ctx.messageId && ctx.token);

  if (listOnly) {
    // 隐藏邮件卡 + 添加表单两个 section
    var hide = ["email-card", "add-section"];
    for (var i = 0; i < hide.length; i++) {
      var el = document.getElementById(hide[i]);
      if (el) el.style.display = "none";
    }
  }

  function ymd(d) { return d.getFullYear() + "-" + fmt2(d.getMonth()+1) + "-" + fmt2(d.getDate()); }
  function hm(d)  { return fmt2(d.getHours()) + ":" + fmt2(d.getMinutes()); }
  function setWhen(d) { $("when-date").value = ymd(d); $("when-time").value = hm(d); }
  function readWhen() {
    var d = $("when-date").value, t = $("when-time").value;
    if (!d || !t) return null;
    return new Date(d + "T" + t);
  }
  function defaultDate() { return new Date(Date.now() + 60000); }

  function applyPreset(mins, btn) {
    var d;
    if (mins === "tomorrow9") {
      d = new Date(); d.setDate(d.getDate()+1); d.setHours(9,0,0,0);
    } else if (mins === "tonight20") {
      d = new Date(); d.setHours(20,0,0,0);
      if (d.getTime() < Date.now()) d.setDate(d.getDate()+1);
    } else {
      d = new Date(Date.now() + Number(mins) * 60000);
    }
    setWhen(d);
    Array.prototype.forEach.call(document.querySelectorAll(".preset"), function(b){ b.classList.remove("active"); });
    if (btn) btn.classList.add("active");
  }
  Array.prototype.forEach.call(document.querySelectorAll(".preset"), function(btn){
    btn.addEventListener("click", function(){ applyPreset(btn.dataset.mins, btn); });
  });

  function setStatus(msg, kind) {
    var s = $("status");
    s.textContent = msg || "";
    s.className = "status" + (kind ? " " + kind : "");
  }

  function fmtWhen(iso) {
    var d = new Date(iso);
    return d.getFullYear() + "-" + fmt2(d.getMonth()+1) + "-" + fmt2(d.getDate())
      + " " + fmt2(d.getHours()) + ":" + fmt2(d.getMinutes());
  }

  function ctxQuery() {
    return "?accountId=" + ctx.accountId
      + "&messageId=" + encodeURIComponent(ctx.messageId)
      + "&token=" + encodeURIComponent(ctx.token);
  }

  function openMail() {
    // 把当前 URL 作为 back 传过去，mail 页 BackButton 据此返回
    var back = encodeURIComponent(location.pathname + location.search);
    var url = "${ROUTE_MINI_APP_MAIL.replace(":id", "")}" + encodeURIComponent(ctx.messageId)
      + "?accountId=" + ctx.accountId + "&t=" + encodeURIComponent(ctx.token)
      + "&back=" + back;
    location.href = url;
  }

  async function loadEmailContext() {
    var card = $("email-card");
    card.addEventListener("click", openMail);
    try {
      var r = await fetch("${ROUTE_REMINDERS_API_EMAIL_CONTEXT}" + ctxQuery(), {
        headers: { "x-telegram-init-data": initData },
      });
      if (!r.ok) throw new Error("ctx");
      var d = await r.json();
      $("email-subject").textContent = d.subject || "(无主题)";
      $("email-from").textContent = d.accountEmail ? "账号: " + d.accountEmail : "";
      card.style.display = "block";
    } catch (e) {
      $("email-subject").textContent = "邮件信息加载失败";
      card.style.display = "block";
    }
  }

  function renderList(items) {
    var ul = $("list");
    ul.innerHTML = "";
    var countEl = $("list-count");
    if (countEl) countEl.textContent = items.length ? " (" + items.length + ")" : "";
    if (!items.length) {
      var e = document.createElement("div");
      e.className = "empty";
      e.textContent = listOnly ? "暂无待提醒事项" : "本邮件还没有设过提醒";
      ul.appendChild(e); return;
    }
    items.forEach(function(it){
      var li = document.createElement("li");
      var meta = document.createElement("div"); meta.className = "meta";
      var when = document.createElement("div"); when.className = "when"; when.textContent = fmtWhen(it.remind_at);
      meta.appendChild(when);
      // email subject 只在 list-only 模式（多封邮件混合）显示；email 模式下顶部
      // 已经有邮件卡，重复就冗余了。
      if (listOnly && it.email_subject) {
        var sub = document.createElement("div"); sub.className = "subject"; sub.textContent = "📧 " + it.email_subject;
        meta.appendChild(sub);
      }
      if (it.text) {
        var text = document.createElement("div"); text.className = "text"; text.textContent = it.text;
        meta.appendChild(text);
      }
      var del = document.createElement("button");
      del.className = "del"; del.type = "button"; del.title = "删除"; del.textContent = "🗑";
      del.addEventListener("click", function(){ deleteItem(it.id, li); });
      li.appendChild(meta); li.appendChild(del);
      ul.appendChild(li);
    });
  }

  async function loadList() {
    // email 模式 → 仅查这封邮件的提醒；list-only → 查用户全部
    var url = "${ROUTE_REMINDERS_API}" + (listOnly ? "" : ctxQuery());
    try {
      var r = await fetch(url, { headers: { "x-telegram-init-data": initData } });
      if (!r.ok) throw new Error("list");
      var d = await r.json();
      renderList(d.reminders || []);
    } catch (e) {
      $("list").innerHTML = '<div class="empty">加载失败</div>';
    }
  }

  async function deleteItem(id, li) {
    try {
      var r = await fetch("${ROUTE_REMINDERS_API}/" + id, {
        method: "DELETE", headers: { "x-telegram-init-data": initData },
      });
      if (!r.ok) throw new Error();
      li.remove();
      var ul = $("list");
      if (!ul.querySelector("li")) {
        ul.innerHTML = '<div class="empty">暂无待提醒事项</div>';
      }
    } catch (e) {
      setStatus("删除失败", "error");
    }
  }

  $("save").addEventListener("click", async function(){
    var text = $("text").value.trim();
    var local = readWhen();
    if (!local) { setStatus("请选择日期和时间", "error"); return; }
    if (isNaN(local.getTime())) { setStatus("时间格式错误", "error"); return; }
    if (local.getTime() <= Date.now()) { setStatus("提醒时间需在未来", "error"); return; }

    $("save").disabled = true;
    setStatus("保存中…");
    try {
      var r = await fetch("${ROUTE_REMINDERS_API}", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-init-data": initData,
        },
        body: JSON.stringify({
          text: text,
          remind_at: local.toISOString(),
          accountId: ctx.accountId,
          messageId: ctx.messageId,
          token: ctx.token,
        }),
      });
      var data = await r.json().catch(function(){ return {}; });
      if (!r.ok || !data.ok) {
        setStatus(data.error || "保存失败", "error");
        return;
      }
      setStatus("✅ 已设定提醒", "ok");
      $("text").value = "";
      setWhen(defaultDate());
      Array.prototype.forEach.call(document.querySelectorAll(".preset"), function(b){ b.classList.remove("active"); });
      loadList();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred("success");
    } catch (e) {
      setStatus("网络错误", "error");
    } finally {
      $("save").disabled = false;
    }
  });

  if (!listOnly) {
    setWhen(defaultDate());
    $("when-date").min = ymd(new Date());
    loadEmailContext();
  } else {
    document.querySelector("h1").textContent = "⏰ 我的提醒";
    $("list-title").textContent = "所有待提醒";
  }
  loadList();
})();
`;
}

export function RemindersPage() {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>邮件提醒 — Telemail</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script src="https://telegram.org/js/telegram-web-app.js" />
        <style dangerouslySetInnerHTML={{ __html: REMINDERS_CSS }} />
      </head>
      <body>
        <div class="wrap">
          <h1>⏰ 邮件提醒</h1>

          <div id="email-card" class="email-card" style="display:none">
            <div id="email-subject" class="subject" />
            <div id="email-from" class="from" />
            <div class="open-hint">点击查看邮件 →</div>
          </div>

          <div id="add-section" class="section">
            <label for="when-date">提醒时间</label>
            <div class="when-row">
              <input id="when-date" type="date" />
              <input id="when-time" type="time" />
            </div>
            <div class="presets">
              <button type="button" class="preset" data-mins="10">
                10 分钟
              </button>
              <button type="button" class="preset" data-mins="30">
                30 分钟
              </button>
              <button type="button" class="preset" data-mins="60">
                1 小时
              </button>
              <button type="button" class="preset" data-mins="180">
                3 小时
              </button>
              <button type="button" class="preset" data-mins="tonight20">
                今晚 20:00
              </button>
              <button type="button" class="preset" data-mins="tomorrow9">
                明早 09:00
              </button>
            </div>

            <label for="text" style="margin-top:14px">
              备注（可选）
            </label>
            <textarea
              id="text"
              maxlength={1000}
              placeholder="可留空 —— 不填只发送邮件主题和链接"
            />

            <button
              id="save"
              type="button"
              class="btn-primary"
              style="margin-top:14px"
            >
              保存提醒
            </button>
            <div id="status" class="status" />
            <div class="helper">时间按你设备的本地时区</div>
          </div>

          <div class="section">
            <div class="section-title">
              <span id="list-title">已设的提醒</span>
              <span id="list-count" />
            </div>
            <ul id="list" class="list">
              <div class="empty">加载中…</div>
            </ul>
          </div>
        </div>
        <script dangerouslySetInnerHTML={{ __html: remindersScript() }} />
      </body>
    </html>
  );
}
