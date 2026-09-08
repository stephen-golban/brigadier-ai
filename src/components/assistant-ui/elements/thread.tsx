// Brigadier viewport adapter around the installed standalone Chat Panel Elements.
import { ChatPanel, ChatPanelMessages } from "./chat-panel";
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
    <ThreadPrimitive.Root asChild>
      <ChatPanel className="aui-thread relative h-auto min-h-0 min-w-0 max-w-none flex-1 rounded-none border-0 bg-canvas dark:bg-canvas">
        <ThreadPrimitive.Viewport
          asChild
          ref={viewportRef}
          onScroll={onScroll}
          scrollToBottomOnInitialize={scrollToBottomOnInitialize}
          scrollToBottomOnRunStart={false}
        >
          <ChatPanelMessages className="aui-viewport block min-h-0 p-0 overscroll-contain">
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
          </ChatPanelMessages>
        </ThreadPrimitive.Viewport>
      </ChatPanel>
    </ThreadPrimitive.Root>
  );
}
