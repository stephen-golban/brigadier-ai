import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PeerIncomingMessage, PeerMessages } from "./PeerMessages";
import { LinkedTaskCards } from "./LinkedTaskCards";
import type { PeerData } from "../../peerApi";
import type { ChatItem } from "../../workspaceApi";
const text = "Full saved peer request. ".repeat(60);
const peers: PeerData = { titles: { source: "Audit delivery", target: "Implement migration" }, origins: {}, closed: [], requests: [], messages: [{ id: "m", from: "source", to: "target", text, work: true, turnId: "turn", delivered: true, error: null }] };
const item: ChatItem = { id: "turn:user", session_id: "target", provider_uuid: "turn", seq: 8, at: 0, body: "transport wrapper", kind: { type: "user-text" }, parent_id: null };
describe("peer presentation", () => {
  it("expands full saved body accessibly and opens the real source; has no owner edit", () => {
    const select = vi.fn();
    render(<PeerIncomingMessage item={item} peers={peers} onSelectSession={select} />);
    expect(screen.getByText("Sent by Brigadier from another task")).toBeTruthy();
    const more = screen.getByRole("button", { name: "Show more" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(more.getAttribute("aria-controls")!)?.textContent).toBe(text);
    fireEvent.click(more);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Open source task: Audit delivery" }));
    expect(select).toHaveBeenCalledWith("source");
    expect(screen.queryByRole("button", { name: /edit/i })).toBeNull();
    expect(item.body).toBe("transport wrapper");
  });
  it("keeps queued, accepted and delivered evidence distinct across a reload", () => {
    const restored = JSON.parse(JSON.stringify({ ...peers, messages: [
      { ...peers.messages[0], id: "q", delivered: false, turnId: null },
      { ...peers.messages[0], id: "p", delivered: false, work: false, turnId: null },
      { ...peers.messages[0], id: "f", delivered: false, error: "Recipient stopped" },
    ] }));
    const view = render(<PeerMessages sessionId="source" peers={restored} />);
    expect(screen.getByText("Queued for delivery")).toBeTruthy();
    expect(screen.getByText(/Accepted in inbox/)).toBeTruthy();
    expect(screen.getByText("Delivery failed: Recipient stopped")).toBeTruthy();
    expect(screen.queryByText("Delivered to CLI")).toBeNull();
    view.rerender(<PeerMessages sessionId="unrelated" peers={restored} />);
    expect(screen.queryByText("Queued for delivery")).toBeNull();
  });
  it("groups real titles and disables unknown navigation while creation is pending", () => {
    const select = vi.fn();
    render(<LinkedTaskCards tasks={Array.from({ length: 5 }, (_, i) => ({ key: `${i}`, id: i ? `task-${i}` : undefined, title: `Concrete task ${i}`, state: i ? "ready" as const : "pending" as const }))} onSelectSession={select} />);
    expect(screen.queryByRole("button", { name: "Open chat: Concrete task 0" })).toBeNull();
    expect(screen.queryByText("Concrete task 4")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more chats" }));
    fireEvent.click(screen.getByRole("button", { name: "Open chat: Concrete task 4" }));
    expect(select).toHaveBeenCalledWith("task-4");
    fireEvent.click(screen.getByRole("button", { name: "Show fewer chats" }));
    expect(screen.queryByText("Concrete task 4")).toBeNull();
  });
});
