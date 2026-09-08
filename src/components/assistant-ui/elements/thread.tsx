// Adapted from assistant-ui Elements Thread (MIT). The host supplies its composer and message renderers.
import { ThreadPrimitive } from "@assistant-ui/react";
import { Button } from "../../controls/button";
import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
export function Thread({
  children,
  viewportRef,
  onScroll,
  scrollToBottomOnInitialize = true,
}: {
  children: ReactNode;
  viewportRef?: React.Ref<HTMLDivElement>;
  onScroll?: ComponentProps<typeof ThreadPrimitive.Viewport>["onScroll"];
  scrollToBottomOnInitialize?: boolean;
}) {
  return (
    <ThreadPrimitive.Root
      className="aui-thread relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
      data-slot="aui-thread"
    >
      <ThreadPrimitive.Viewport
        className="aui-viewport min-h-0 flex-1 overflow-y-auto overscroll-contain"
        ref={viewportRef}
        onScroll={onScroll}
        scrollToBottomOnInitialize={scrollToBottomOnInitialize}
        scrollToBottomOnRunStart={false}
      >
        <div className="aui-thread-content mx-auto w-full max-w-[820px] px-6 py-6">
          {children}
        </div>
        <ThreadPrimitive.ViewportFooter className="aui-thread-footer sticky bottom-3 flex justify-center [&_button:disabled]:hidden">
          <ThreadPrimitive.ScrollToBottom asChild>
            <Button
              variant="secondary"
              isIconOnly
              size="sm"
              aria-label="Jump to latest"
              className="rounded-full shadow-overlay"
            >
              <ArrowDownIcon size={18} />
            </Button>
          </ThreadPrimitive.ScrollToBottom>
        </ThreadPrimitive.ViewportFooter>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}
