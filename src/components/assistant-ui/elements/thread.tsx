// Brigadier viewport adapter around the installed standalone Chat Panel Elements.
import { ChatPanel, ChatPanelMessages } from "./chat-panel";
import { ThreadPrimitive } from "@assistant-ui/react";
import { Button } from "@/components/ui/button";
import { ArrowDown } from "../../../icons";
import {useRef,useLayoutEffect,type ComponentProps,type ReactNode} from "react";
export function Thread({
  children,
  readOnly = false,
  viewportRef,
  onScroll,
  scrollToBottomOnInitialize = true,
}: {
  children: ReactNode;
  readOnly?: boolean;
  viewportRef?: React.Ref<HTMLDivElement>;
  onScroll?: ComponentProps<typeof ThreadPrimitive.Viewport>["onScroll"];
  scrollToBottomOnInitialize?: boolean;
}) {
  if(readOnly) return <ReadonlyViewport viewportRef={viewportRef} onScroll={onScroll} followingInitially={scrollToBottomOnInitialize}>{children}</ReadonlyViewport>;
  return (
    <ThreadPrimitive.Root asChild>
      <ChatPanel className="aui-thread relative h-auto min-h-0 min-w-0 max-w-none flex-1 rounded-none border-0 bg-canvas">
        <ThreadPrimitive.Viewport
          asChild
          ref={viewportRef}
          onScroll={onScroll}
          scrollToBottomOnInitialize={scrollToBottomOnInitialize}
          scrollToBottomOnRunStart={false}
        >
          <ChatPanelMessages className="aui-viewport block min-h-0 p-0 overscroll-contain">
            <div className="aui-thread-content mx-auto w-full max-w-[var(--thread-max-width)] px-[var(--thread-pad-x)] pt-[var(--thread-pad-x)] pb-[var(--thread-pad-bottom)]">
              {children}
            </div>
            <ThreadPrimitive.ViewportFooter className="aui-thread-footer sticky bottom-3 flex justify-center [&_button:disabled]:hidden">
              <ThreadPrimitive.ScrollToBottom asChild>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label="Jump to latest"
                  className="rounded-full shadow-overlay"
                >
                  <ArrowDown width={18} height={18} />
                </Button>
              </ThreadPrimitive.ScrollToBottom>
            </ThreadPrimitive.ViewportFooter>
          </ChatPanelMessages>
        </ThreadPrimitive.Viewport>
      </ChatPanel>
    </ThreadPrimitive.Root>
  );
}

// The installed ThreadPrimitive viewport assumes a writable thread-list scope. A saved worker
// has only ReadonlyThreadProvider; use its standalone Chat Panel Elements without that assumption.
function ReadonlyViewport({children,viewportRef,onScroll,followingInitially}:{children:ReactNode;viewportRef?:React.Ref<HTMLDivElement>;onScroll?:ComponentProps<'div'>['onScroll'];followingInitially:boolean}){
 const viewport=useRef<HTMLDivElement|null>(null);const following=useRef(followingInitially);
 useLayoutEffect(()=>{if(following.current&&viewport.current)viewport.current.scrollTop=viewport.current.scrollHeight;},[children]);
 return <ChatPanel className="aui-thread relative h-auto min-h-0 min-w-0 max-w-none flex-1 rounded-none border-0 bg-canvas">
   <ChatPanelMessages ref={node=>{viewport.current=node;if(typeof viewportRef==='function')viewportRef(node);else if(viewportRef)viewportRef.current=node;}} className="aui-viewport block min-h-0 p-0 overscroll-contain" onScroll={event=>{const e=event.currentTarget;following.current=e.scrollHeight-e.scrollTop-e.clientHeight<64;onScroll?.(event);}}>
     <div className="aui-thread-content mx-auto w-full max-w-[var(--thread-max-width)] px-[var(--thread-pad-x)] pt-[var(--thread-pad-x)] pb-[var(--thread-pad-bottom)]">{children}</div>
   </ChatPanelMessages>
 </ChatPanel>;
}
