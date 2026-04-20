import { theme } from "@assets/theme";
import { MINIAPP_BASE_CSS } from "@components/miniapp/styles";
import type { Child } from "hono/jsx";
import type { MailMeta } from "@/types";

interface MailPageProps {
  meta: MailMeta;
  accountEmail?: string | null;
  messageId: string;
  accountId: number;
  token: string;
  inJunk: boolean;
  inArchive: boolean;
  starred: boolean;
  canArchive: boolean;
  /** 用于"在浏览器打开"按钮，跳转到 web 版 mail page（保留原 folder 参数） */
  webMailUrl: string;
  /** 跳回 TG 里原邮件消息的深链接，没 mapping 时省略 */
  tgMessageLink?: string;
  children: Child;
}

const PAGE_CSS = `${MINIAPP_BASE_CSS}
html { padding: 0; }
.mail-meta {
  background: var(--surface);
  border-bottom: 1px solid var(--separator);
  padding: 12px 16px;
  font-size: 13px;
  line-height: 1.7;
}
.mail-meta .subject {
  font-size: 22px; font-weight: 600; margin-bottom: 6px; word-break: break-word;
  color: var(--tg-theme-link-color, #60a5fa);
  cursor: pointer; -webkit-tap-highlight-color: transparent;
}
.mail-meta .subject:active { opacity: .6; }
.mail-meta .subject .ext { font-size: 14px; opacity: .7; margin-left: 4px; }
.mail-meta .actions { margin-top: 6px; display: flex; gap: 12px; flex-wrap: wrap; }
.mail-meta .actions a {
  font-size: 12px; color: var(--tg-theme-link-color, #60a5fa);
  text-decoration: none; -webkit-tap-highlight-color: transparent;
}
.mail-meta .actions a:active { opacity: .6; }
.mail-meta .label { color: var(--hint); }
.mail-body { padding: 16px; padding-bottom: 100px; word-break: break-word; }
`;

const FAB_CSS = `
:root{
  --fab-primary:${theme.primary};
  --fab-primary-hover:${theme.primaryHover};
  --fab-danger:${theme.danger};
  --fab-bg:${theme.surface};
  --fab-border:${theme.border};
}
#mail-fab{
  position:fixed;bottom:24px;right:24px;z-index:9999;
  display:flex;flex-direction:column;align-items:flex-end;gap:10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
@media(max-width:640px){ #mail-fab{bottom:16px;right:16px} }
#mail-fab .fab-main{
  width:52px;height:52px;border-radius:50%;
  background:var(--fab-primary);color:#fff;border:none;
  font-size:22px;cursor:pointer;
  box-shadow:0 4px 14px rgba(0,0,0,.35);
  transition:transform .2s,background .2s;
  -webkit-tap-highlight-color:transparent;
}
#mail-fab .fab-main:hover{background:var(--fab-primary-hover)}
#mail-fab .fab-main.open{transform:rotate(45deg);background:var(--fab-border)}
#mail-fab .fab-actions{ display:none;flex-direction:column;align-items:flex-end;gap:8px; }
#mail-fab .fab-actions.show{display:flex}
#mail-fab .fab-btn{
  display:flex;align-items:center;gap:8px;
  padding:10px 18px;border-radius:24px;border:none;
  color:#fff;font-size:14px;cursor:pointer;
  box-shadow:0 2px 10px rgba(0,0,0,.3);
  white-space:nowrap;transition:opacity .2s;
  -webkit-tap-highlight-color:transparent;
}
@media(max-width:640px){ #mail-fab .fab-btn{padding:12px 20px;font-size:15px} }
#mail-fab .fab-btn:disabled{opacity:.5;cursor:default}
#mail-fab .fab-btn.inbox{background:var(--fab-primary)}
#mail-fab .fab-btn.del{background:var(--fab-danger)}
#mail-fab .fab-btn.star{background:#f59e0b}
#mail-fab .fab-btn.starred{background:#22c55e}
#mail-fab .fab-btn.archive{background:#6366f1}
#mail-fab .fab-status{
  background:var(--fab-bg);color:var(--text);
  padding:8px 16px;border-radius:16px;font-size:13px;
  border:1px solid var(--fab-border);
  box-shadow:0 2px 8px rgba(0,0,0,.3);
  display:none;max-width:260px;text-align:center;
}
#mail-fab .fab-status.show{display:block}
`;

function fabScript(
  messageId: string,
  accountId: number,
  token: string,
  starred: boolean,
  webMailUrl: string,
  tgMessageLink: string | undefined,
): string {
  return `
var tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready(); tg.expand();
  // TG 顶栏 BackButton：仅当 URL 带 ?back= 时显示，跳转回该 URL。
  // 直接 deep link / web_app 进来时不带 back，按钮隐藏 —— 用户用 TG 自带的 X 关闭。
  // 显式 back URL 比 window.history 更可靠：避免跨页面残留的 BackButton 状态错乱。
  if (tg.BackButton) {
    var backUrl = new URLSearchParams(location.search).get("back");
    if (backUrl) {
      tg.BackButton.show();
      tg.BackButton.onClick(function(){ location.href = backUrl; });
    } else {
      tg.BackButton.hide();
    }
  }
}
var _starred=${starred ? "true" : "false"};
function openInBrowser(){
  var url = ${JSON.stringify(webMailUrl)};
  if (tg && tg.openLink) tg.openLink(url);
  else window.open(url, "_blank");
}
function openTgMessage(){
  var url = ${JSON.stringify(tgMessageLink ?? "")};
  if (!url) return;
  // openTelegramLink 处理 t.me/* 链接，跳到 TG 内对应聊天/消息。
  // 文档说会自动关 Mini App，实测部分客户端不会 —— 显式 close() 兜底；
  // 用 setTimeout 让 openTelegramLink 先被处理，再 close。
  if (tg && tg.openTelegramLink) {
    tg.openTelegramLink(url);
    setTimeout(function(){ if (tg.close) tg.close(); }, 50);
  } else if (tg && tg.openLink) {
    tg.openLink(url);
  } else {
    window.open(url, "_blank");
  }
}
function toggleFab(btn){
  btn.classList.toggle('open');
  document.getElementById('fab-actions').classList.toggle('show');
  document.getElementById('fab-status').className='fab-status';
}
async function mailAction(action,btn){
  var s=document.getElementById('fab-status');
  btn.disabled=true;s.className='fab-status show';s.textContent='处理中...';
  try{
    var r=await fetch('/api/mail/${encodeURIComponent(messageId)}/'+action,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({accountId:${accountId},token:'${token}'})
    });
    var d=await r.json();
    s.textContent=d.ok?'\\u2705 '+d.message:'\\u274c '+(d.error||'操作失败');
    if(d.ok){document.querySelectorAll('.fab-btn').forEach(function(b){b.disabled=true})}
  }catch(e){s.textContent='\\u274c 网络错误'}
}
async function toggleStar(btn){
  var s=document.getElementById('fab-status');
  btn.disabled=true;s.className='fab-status show';s.textContent='处理中...';
  try{
    var r=await fetch('/api/mail/${encodeURIComponent(messageId)}/toggle-star',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({accountId:${accountId},token:'${token}',starred:!_starred})
    });
    var d=await r.json();
    if(d.ok){
      _starred=!_starred;
      btn.className=_starred?'fab-btn starred':'fab-btn star';
      btn.textContent=_starred?'\\u2705 已星标':'\\u2B50 星标';
      s.textContent='\\u2705 '+d.message;
    }else{s.textContent='\\u274c '+(d.error||'操作失败')}
  }catch(e){s.textContent='\\u274c 网络错误'}
  finally{btn.disabled=false}
}`;
}

function MailMetaHeader({
  meta,
  accountEmail,
  webMailUrl,
  tgMessageLink,
}: {
  meta: MailMeta;
  accountEmail?: string | null;
  webMailUrl: string;
  tgMessageLink?: string;
}) {
  if (!meta.subject && !meta.from && !meta.to && !accountEmail && !meta.date)
    return null;

  return (
    <div class="mail-meta">
      {meta.subject && (
        <a
          class="subject"
          href={webMailUrl}
          onclick="openInBrowser();return false;"
          title="在浏览器打开"
        >
          {meta.subject}
          <span class="ext">↗</span>
        </a>
      )}
      {tgMessageLink && (
        <div class="actions">
          <a href={tgMessageLink} onclick="openTgMessage();return false;">
            💬 跳到 TG 原消息
          </a>
        </div>
      )}
      {meta.from && (
        <div>
          <span class="label">From:</span> {meta.from}
        </div>
      )}
      {meta.to && (
        <div>
          <span class="label">To:</span> {meta.to}
        </div>
      )}
      {accountEmail && (
        <div>
          <span class="label">Account:</span> {accountEmail}
        </div>
      )}
      {meta.date && (
        <div>
          <span class="label">Date:</span> {meta.date}
        </div>
      )}
    </div>
  );
}

function MailFab({
  messageId,
  accountId,
  token,
  inJunk,
  inArchive,
  starred,
  canArchive,
  webMailUrl,
  tgMessageLink,
}: {
  messageId: string;
  accountId: number;
  token: string;
  inJunk: boolean;
  inArchive: boolean;
  starred: boolean;
  canArchive: boolean;
  webMailUrl: string;
  tgMessageLink?: string;
}) {
  return (
    <>
      <div id="mail-fab">
        <div id="fab-status" class="fab-status" />
        <div id="fab-actions" class="fab-actions">
          {!inArchive && (
            <button
              type="button"
              class={`fab-btn ${starred ? "starred" : "star"}`}
              onclick="toggleStar(this)"
            >
              {starred ? "✅ 已星标" : "⭐ 星标"}
            </button>
          )}
          {inJunk ? (
            <>
              <button
                type="button"
                class="fab-btn inbox"
                onclick="mailAction('move-to-inbox',this)"
              >
                📥 移到收件箱
              </button>
              <button
                type="button"
                class="fab-btn del"
                onclick="mailAction('trash',this)"
              >
                🗑 删除邮件
              </button>
            </>
          ) : inArchive ? (
            <button
              type="button"
              class="fab-btn inbox"
              onclick="mailAction('unarchive',this)"
            >
              📥 移出归档
            </button>
          ) : (
            <>
              {canArchive && (
                <button
                  type="button"
                  class="fab-btn archive"
                  onclick="mailAction('archive',this)"
                >
                  📥 归档
                </button>
              )}
              <button
                type="button"
                class="fab-btn del"
                onclick="mailAction('mark-as-junk',this)"
              >
                🚫 标记为垃圾
              </button>
            </>
          )}
        </div>
        <button type="button" class="fab-main" onclick="toggleFab(this)">
          ⚡
        </button>
      </div>
      <script
        dangerouslySetInnerHTML={{
          __html: fabScript(
            messageId,
            accountId,
            token,
            starred,
            webMailUrl,
            tgMessageLink,
          ),
        }}
      />
    </>
  );
}

export function MiniAppMailPage({
  meta,
  accountEmail,
  messageId,
  accountId,
  token,
  inJunk,
  inArchive,
  starred,
  canArchive,
  webMailUrl,
  tgMessageLink,
  children,
}: MailPageProps) {
  return (
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <title>{meta.subject || "邮件"} — Telemail</title>
        <link rel="icon" type="image/png" href="/favicon.png" />
        <script src="https://telegram.org/js/telegram-web-app.js" />
        <style dangerouslySetInnerHTML={{ __html: PAGE_CSS + FAB_CSS }} />
      </head>
      <body>
        <MailMetaHeader
          meta={meta}
          accountEmail={accountEmail}
          webMailUrl={webMailUrl}
          tgMessageLink={tgMessageLink}
        />
        <div class="mail-body">{children}</div>
        <MailFab
          messageId={messageId}
          accountId={accountId}
          token={token}
          inJunk={inJunk}
          inArchive={inArchive}
          starred={starred}
          canArchive={canArchive}
          webMailUrl={webMailUrl}
          tgMessageLink={tgMessageLink}
        />
      </body>
    </html>
  );
}
