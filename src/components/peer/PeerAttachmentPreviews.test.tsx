import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PeerAttachmentPreviews } from "./PeerAttachmentPreviews";
import { peerApi, type PeerMessage } from "../../peerApi";
const attachment = { id: "image", projectId: "p", name: "Reference.png", mediaType: "image/png", size: 4, createdAt: 0 };
const message: PeerMessage = { id: "m", from: "a", to: "b", text: "Review", work: true, delivered: true, error: null, attachments: [attachment] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("loads attachment bytes on demand and keeps them across peer snapshot refreshes", async () => {
  const read = vi.spyOn(peerApi, "attachment").mockResolvedValue({ metadata: attachment, base64: "cG5n" });
  const view = render(<PeerAttachmentPreviews message={message} />);
  expect(read).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "View attachment: Reference.png" }));
  expect(await screen.findByRole("img", { name: "Reference.png" })).toHaveAttribute("src", "data:image/png;base64,cG5n");
  expect(screen.getByRole("link", { name: "Download Reference.png" })).toHaveAttribute("download", "Reference.png");
  view.rerender(<PeerAttachmentPreviews message={JSON.parse(JSON.stringify(message))} />);
  expect(read).toHaveBeenCalledTimes(1);
});
it("reports inaccessible retained files and permits retry", async () => {
  const read = vi.spyOn(peerApi, "attachment").mockRejectedValueOnce(new Error("File is missing")).mockResolvedValue({ metadata: attachment, base64: "cG5n" });
  render(<PeerAttachmentPreviews message={message} />);
  fireEvent.click(screen.getByRole("button", { name: "View attachment: Reference.png" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("File is missing");
  fireEvent.click(screen.getByRole("button", { name: "View attachment: Reference.png" }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  expect(await screen.findByRole("img", { name: "Reference.png" })).toBeVisible();
});
