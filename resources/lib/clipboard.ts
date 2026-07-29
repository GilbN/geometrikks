/**
 * Clipboard writes that also work on insecure origins.
 *
 * `navigator.clipboard` only exists in a secure context: HTTPS, or a loopback
 * host like `http://localhost`. GeoMetrikks is commonly reached over plain HTTP
 * on a LAN address, where the whole Clipboard API is missing and nothing the
 * server sends can change that, so fall back to a hidden-textarea
 * `document.execCommand("copy")`. That call is deprecated but is not gated on
 * secure context, and it remains the only way to copy from an insecure origin.
 */

/** The async Clipboard API surface used here, narrowed so tests can fake it. */
type ClipboardWriter = Pick<Clipboard, "writeText">

export interface CopyTextOptions {
  /**
   * Element the fallback textarea is appended to. Pass the dialog or popover
   * that owns the copy button: a focus trap bounces focus out of anything
   * mounted outside it, which drops the selection before the copy runs.
   * Defaults to `document.body`.
   */
  container?: HTMLElement | null
  /** Overrides `navigator.clipboard`. Injected by tests. */
  clipboard?: ClipboardWriter
  /** Overrides `globalThis.document`. Injected by tests. */
  document?: Document
}

const FALLBACK_STYLE = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;"

/**
 * Copies `text`, returning whether it landed on the clipboard.
 *
 * Callers must handle `false`: on an insecure origin with a browser that has
 * dropped `execCommand` there is no way to copy, and silently doing nothing
 * reads as a broken button.
 */
export async function copyText(text: string, options: CopyTextOptions = {}): Promise<boolean> {
  const clipboard = "clipboard" in options ? options.clipboard : globalThis.navigator?.clipboard
  const doc = "document" in options ? options.document : globalThis.document

  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Permission denied, or the document is not focused. Try the fallback.
    }
  }

  if (!doc) return false
  return copyViaExecCommand(text, doc, options.container ?? doc.body)
}

function copyViaExecCommand(text: string, doc: Document, host: HTMLElement): boolean {
  const textarea = doc.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.setAttribute("aria-hidden", "true")
  textarea.setAttribute("tabindex", "-1")
  textarea.setAttribute("style", FALLBACK_STYLE)
  host.append(textarea)

  const previouslyFocused = doc.activeElement as HTMLElement | null
  try {
    textarea.focus({ preventScroll: true })
    textarea.select()
    // Safari ignores select() on a readOnly textarea.
    textarea.setSelectionRange(0, text.length)
    return doc.execCommand("copy")
  } catch {
    return false
  } finally {
    textarea.remove()
    previouslyFocused?.focus?.({ preventScroll: true })
  }
}
