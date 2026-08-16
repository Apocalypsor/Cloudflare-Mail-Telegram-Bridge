import type { FlatMailListItem } from "@page/utils/mail-list-pagination";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import type { MailListAccountResult } from "@worker/api/modules/miniapp/model";
import {
  type ReactNode,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

const formatEmailOnly = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const emails = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  return emails && emails.length > 0 ? emails.join(", ") : value;
};

export const MailListAddressMeta = ({
  item,
}: {
  item: Pick<FlatMailListItem, "from" | "to">;
}) => {
  const to = formatEmailOnly(item.to);
  return (
    <div className="mt-1.5 space-y-0.5 text-[11px] leading-4 wrap-break-word">
      {item.from && <div className="min-w-0 text-zinc-100">{item.from}</div>}
      {to && <div className="min-w-0 text-zinc-500">{to}</div>}
    </div>
  );
};

export const MailListFlat = ({
  items,
  errors,
  errorLabel,
  children,
}: {
  items: FlatMailListItem[];
  errors?: MailListAccountResult[];
  errorLabel: (result: MailListAccountResult) => string;
  children: (item: FlatMailListItem) => ReactNode;
}) => {
  const listRef = useRef<HTMLUListElement | null>(null);
  const [scrollMargin, setScrollMargin] = useState(0);
  const rowVirtualizer = useWindowVirtualizer<HTMLLIElement>({
    count: items.length,
    estimateSize: () => 92,
    getItemKey: (index) => `${items[index].accountId}:${items[index].id}`,
    overscan: 8,
    scrollMargin,
  });
  const updateScrollMargin = useCallback(() => {
    const node = listRef.current;
    if (!node) return;
    const next = node.getBoundingClientRect().top + window.scrollY;
    setScrollMargin((current) => (current === next ? current : next));
  }, []);

  useLayoutEffect(() => {
    updateScrollMargin();
  });

  useLayoutEffect(() => {
    updateScrollMargin();
    window.addEventListener("resize", updateScrollMargin);
    return () => window.removeEventListener("resize", updateScrollMargin);
  }, [updateScrollMargin]);

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900 overflow-hidden">
      {errors && errors.length > 0 && (
        <div className="divide-y divide-red-900/40 border-b border-zinc-800 bg-red-950/20">
          {errors.map((result) => (
            <div
              key={result.accountId}
              className="px-4 py-3 text-sm text-red-300"
            >
              <span className="font-medium">
                {result.accountEmail || `Account #${result.accountId}`}
              </span>
              <span className="text-red-400"> · {errorLabel(result)}</span>
            </div>
          ))}
        </div>
      )}
      <ul
        ref={listRef}
        className="relative"
        style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
      >
        {virtualItems.map((virtualItem) => {
          const item = items[virtualItem.index];
          return (
            <li
              key={virtualItem.key}
              data-index={virtualItem.index}
              ref={rowVirtualizer.measureElement}
              className={`absolute left-0 top-0 w-full ${
                virtualItem.index > 0 ? "border-t border-zinc-800" : ""
              }`}
              style={{
                transform: `translateY(${
                  virtualItem.start - rowVirtualizer.options.scrollMargin
                }px)`,
              }}
            >
              {children(item)}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
