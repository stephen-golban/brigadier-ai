import { act, fireEvent } from "@testing-library/react";
/** jsdom has no native contenteditable beforeinput editing. Exercise the editor's real paste command. */
export async function pasteComposer(element: HTMLElement, text: string) {
  await act(async () => { element.focus(); });
  fireEvent.paste(element, { clipboardData: { files: [], getData: (type: string) => type === "text/plain" ? text : "" } });
  await act(async () => {});
}
export async function replaceComposer(element: HTMLElement, text: string) {
  await act(async () => {
    element.focus();
    const selection = window.getSelection(); const range = document.createRange();
    range.selectNodeContents(element); selection?.removeAllRanges(); selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await pasteComposer(element, text);
}
