import { describe, expect, it, vi } from "vitest"
import { copyText } from "./clipboard"

function fakeTextarea() {
  return {
    value: "",
    readOnly: false,
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  }
}

function fakeDocument(execCommandResult: boolean) {
  const textarea = fakeTextarea()
  const body = { append: vi.fn() }
  const document = {
    createElement: vi.fn(() => textarea),
    execCommand: vi.fn(() => execCommandResult),
    activeElement: null,
    body,
  }
  return { document: document as unknown as Document, textarea, body }
}

describe("copyText", () => {
  it("uses the async Clipboard API when it is available", async () => {
    const writeText = vi.fn(async () => {})
    const { document, body } = fakeDocument(true)

    await expect(copyText("hello", { clipboard: { writeText }, document })).resolves.toBe(true)
    expect(writeText).toHaveBeenCalledWith("hello")
    expect(body.append).not.toHaveBeenCalled()
  })

  it("falls back to execCommand on an insecure origin, where clipboard is undefined", async () => {
    const { document, textarea, body } = fakeDocument(true)

    await expect(copyText("raw log line", { clipboard: undefined, document })).resolves.toBe(true)
    expect(textarea.value).toBe("raw log line")
    expect(body.append).toHaveBeenCalledWith(textarea)
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, "raw log line".length)
    expect(document.execCommand).toHaveBeenCalledWith("copy")
  })

  it("falls back to execCommand when writeText rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Document is not focused")
    })
    const { document } = fakeDocument(true)

    await expect(copyText("hello", { clipboard: { writeText }, document })).resolves.toBe(true)
    expect(document.execCommand).toHaveBeenCalledWith("copy")
  })

  it("appends into the given container so a focus trap cannot steal the selection", async () => {
    const { document, textarea, body } = fakeDocument(true)
    const container = { append: vi.fn() } as unknown as HTMLElement

    await copyText("hello", { clipboard: undefined, document, container })
    expect(container.append).toHaveBeenCalledWith(textarea)
    expect(body.append).not.toHaveBeenCalled()
  })

  it("always removes the textarea it appended", async () => {
    const { document, textarea } = fakeDocument(false)

    await copyText("hello", { clipboard: undefined, document })
    expect(textarea.remove).toHaveBeenCalled()
  })

  it("reports failure when execCommand refuses to copy", async () => {
    const { document } = fakeDocument(false)

    await expect(copyText("hello", { clipboard: undefined, document })).resolves.toBe(false)
  })

  it("reports failure when neither clipboard nor document is available", async () => {
    await expect(copyText("hello", { clipboard: undefined, document: undefined })).resolves.toBe(
      false,
    )
  })
})
