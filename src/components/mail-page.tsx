import { theme } from "@assets/theme";
import type { Child } from "hono/jsx";
import type { MailMeta } from "@/types";

interface MailPageProps {
  meta: MailMeta;
  accountEmail?: string | null;
  messageId: string;
  accountId: number;
  token: string;
  inJunk: boolean;
  starred: boolean;
  canArchive: boolean;
  children: Child;
}

export function MailPage({
  meta,
  accountEmail,
  messageId,
  accountId,
  token,
  inJunk,
  starred,
  canArchive,
  children,
}: MailPageProps) {
  return (
    <>
      <MailMetaHeader meta={meta} accountEmail={accountEmail} />
      {children}
      <MailFab
        messageId={messageId}
        accountId={accountId}
        token={token}
        inJunk={inJunk}
        starred={starred}
        canArchive={canArchive}
      />
    </>
  );
}

function MailMetaHeader({
  meta,
  accountEmail,
}: {
  meta: MailMeta;
  accountEmail?: string | null;
}) {
  if (!meta.subject && !meta.from && !meta.to && !accountEmail && !meta.date)
    return null;

  return (
    <div
      style={`background:${theme.surface};border-bottom:1px solid ${theme.border};padding:12px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:13px;color:${theme.text};line-height:1.7`}
    >
      {meta.subject && (
        <div
          style={`font-size:24px;font-weight:600;color:${theme.text};margin-bottom:6px`}
        >
          {meta.subject}
        </div>
      )}
      {meta.from && (
        <div>
          <span style={`color:${theme.muted}`}>From:</span> {meta.from}
        </div>
      )}
      {meta.to && (
        <div>
          <span style={`color:${theme.muted}`}>To:</span> {meta.to}
        </div>
      )}
      {accountEmail && (
        <div>
          <span style={`color:${theme.muted}`}>Account:</span> {accountEmail}
        </div>
      )}
      {meta.date && (
        <div>
          <span style={`color:${theme.muted}`}>Date:</span> {meta.date}
        </div>
      )}
    </div>
  );
}

const FAB_CSS = `
:root{
  --fab-primary:${theme.primary};
  --fab-primary-hover:${theme.primaryHover};
  --fab-danger:${theme.danger};
  --fab-bg:${theme.surface};
  --fab-border:${theme.border};
  --fab-text:${theme.text};
  --fab-muted:${theme.muted};
}
#mail-fab{
  position:fixed;bottom:24px;right:24px;z-index:9999;
  display:flex;flex-direction:column;align-items:flex-end;gap:10px;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
}
@media(max-width:640px){
  #mail-fab{bottom:16px;right:16px}
}
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
#mail-fab .fab-actions{
  display:none;flex-direction:column;align-items:flex-end;gap:8px;
}
#mail-fab .fab-actions.show{display:flex}
#mail-fab .fab-btn{
  display:flex;align-items:center;gap:8px;
  padding:10px 18px;border-radius:24px;border:none;
  color:#fff;font-size:14px;cursor:pointer;
  box-shadow:0 2px 10px rgba(0,0,0,.3);
  white-space:nowrap;transition:opacity .2s;
  -webkit-tap-highlight-color:transparent;
}
@media(max-width:640px){
  #mail-fab .fab-btn{padding:12px 20px;font-size:15px}
}
#mail-fab .fab-btn:disabled{opacity:.5;cursor:default}
#mail-fab .fab-btn.inbox{background:var(--fab-primary)}
#mail-fab .fab-btn.del{background:var(--fab-danger)}
#mail-fab .fab-btn.star{background:#f59e0b}
#mail-fab .fab-btn.starred{background:#22c55e}
#mail-fab .fab-btn.archive{background:#6366f1}
#mail-fab .fab-status{
  background:var(--fab-bg);color:var(--fab-muted);
  padding:8px 16px;border-radius:16px;font-size:13px;
  border:1px solid var(--fab-border);
  box-shadow:0 2px 8px rgba(0,0,0,.3);
  display:none;max-width:260px;text-align:center;
}
#mail-fab .fab-status.show{display:block}`;

function fabScript(
  messageId: string,
  accountId: number,
  token: string,
  starred: boolean,
): string {
  return `
var _starred=${starred ? "true" : "false"};
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

function MailFab({
  messageId,
  accountId,
  token,
  inJunk,
  starred,
  canArchive,
}: {
  messageId: string;
  accountId: number;
  token: string;
  inJunk: boolean;
  starred: boolean;
  canArchive: boolean;
}) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FAB_CSS }} />
      <div id="mail-fab">
        <div id="fab-status" class="fab-status" />
        <div id="fab-actions" class="fab-actions">
          <button
            type="button"
            class={`fab-btn ${starred ? "starred" : "star"}`}
            onclick="toggleStar(this)"
          >
            {starred ? "✅ 已星标" : "⭐ 星标"}
          </button>
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
          __html: fabScript(messageId, accountId, token, starred),
        }}
      />
    </>
  );
}
