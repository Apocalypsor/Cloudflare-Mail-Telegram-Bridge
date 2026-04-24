/**
 * `useRequireTelegramLogin` 返回 loading 或 redirecting 时，页面盖的一层
 * placeholder —— 避免未登录用户在跳 `/login` 之前瞥见真正的表单。
 */
export function SessionGatePlaceholder({
  redirecting,
}: {
  redirecting: boolean;
}) {
  return (
    <div className="max-w-md mx-auto mt-16 rounded-xl border border-zinc-800 bg-zinc-900 p-8 text-center">
      <p className="text-sm text-zinc-500">
        {redirecting ? "跳转到登录页…" : "验证登录状态…"}
      </p>
    </div>
  );
}
