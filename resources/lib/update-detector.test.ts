import { describe, expect, it, vi } from "vitest"
import { buildKey, createUpdateDetector, type BuildIdentity } from "./update-detector"

function build(version: string, changelogDigest: string | null = null): BuildIdentity {
  return { version, changelogDigest }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function setup(readServerBuild: () => Promise<BuildIdentity>, now = () => 0) {
  const onServerBuild = vi.fn()
  const detector = createUpdateDetector({ readServerBuild, onServerBuild, now })
  return { detector, onServerBuild }
}

describe("buildKey", () => {
  it("uses the version for a release", () => {
    expect(buildKey(build("0.23.0", "abc"))).toBe("0.23.0")
  })

  it("uses the version for a dev tag", () => {
    expect(buildKey(build("0.22.0.dev4+g52b67d62c", "abc"))).toBe("0.22.0.dev4+g52b67d62c")
  })

  it("uses the changelog digest for a local build", () => {
    expect(buildKey(build("0.0.0+local", "d1"))).toBe("d1")
  })

  it("falls back to the version for a local build without a digest", () => {
    expect(buildKey(build("0.0.0+local", null))).toBe("0.0.0+local")
    expect(buildKey(build("unknown", null))).toBe("unknown")
  })
})

describe("createUpdateDetector", () => {
  it("start reads the page build once, however often it is called", async () => {
    const readServerBuild = vi.fn().mockResolvedValue(build("0.22.0"))
    const { detector } = setup(readServerBuild)
    await Promise.all([detector.start(), detector.start()])
    await detector.start()
    expect(readServerBuild).toHaveBeenCalledTimes(1)
    expect(detector.pageBuildKey()).toBe("0.22.0")
  })

  it("the first startedAt only sets the baseline", async () => {
    const readServerBuild = vi.fn().mockResolvedValue(build("0.22.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    expect(readServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).not.toHaveBeenCalled()
  })

  it("a new startedAt with a different key reports a new build", async () => {
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    await detector.observeStartedAt("t2")
    expect(onServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).toHaveBeenCalledWith(build("0.23.0"), true)
  })

  it("a restart that kept the version reports no new build", async () => {
    const readServerBuild = vi.fn().mockResolvedValue(build("0.22.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    await detector.observeStartedAt("t2")
    expect(onServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).toHaveBeenCalledWith(build("0.22.0"), false)
  })

  it("a failed read retries on every poll until one succeeds", async () => {
    const readServerBuild = vi
      .fn()
      .mockResolvedValueOnce(build("0.22.0"))
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValueOnce(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    await detector.observeStartedAt("t2")
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).not.toHaveBeenCalled()

    await detector.observeStartedAt("t2")
    expect(readServerBuild).toHaveBeenCalledTimes(3)
    expect(onServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).toHaveBeenCalledWith(build("0.23.0"), true)

    await detector.observeStartedAt("t2")
    expect(readServerBuild).toHaveBeenCalledTimes(3)
  })

  it("never runs two reads at once", async () => {
    const pendingRead = deferred<BuildIdentity>()
    const readServerBuild = vi
      .fn()
      .mockResolvedValueOnce(build("0.22.0"))
      .mockReturnValueOnce(pendingRead.promise)
      .mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    const firstCheck = detector.observeStartedAt("t2")
    const secondCheck = detector.observeStartedAt("t3")
    const thirdCheck = detector.observeStartedAt("t4")
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    pendingRead.resolve(build("0.22.0"))
    await Promise.all([firstCheck, secondCheck, thirdCheck])
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).toHaveBeenLastCalledWith(build("0.22.0"), false)

    await detector.observeStartedAt("t4")
    expect(readServerBuild).toHaveBeenCalledTimes(3)
    expect(onServerBuild).toHaveBeenLastCalledWith(build("0.23.0"), true)
  })

  it("a recheck during an observe's read shares that read", async () => {
    const pendingRead = deferred<BuildIdentity>()
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockReturnValueOnce(pendingRead.promise)
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    const observed = detector.observeStartedAt("t2")
    const rechecked = detector.recheck()
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    pendingRead.resolve(build("0.23.0"))
    await Promise.all([observed, rechecked])
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).toHaveBeenCalledTimes(1)
  })

  it("an observe during a recheck's read shares that read", async () => {
    const pendingRead = deferred<BuildIdentity>()
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockReturnValueOnce(pendingRead.promise)
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    const rechecked = detector.recheck()
    const observed = detector.observeStartedAt("t2")
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    pendingRead.resolve(build("0.23.0"))
    await Promise.all([rechecked, observed])
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).toHaveBeenCalledTimes(1)
  })

  it("keeps a startedAt change seen while the first build read is pending", async () => {
    const pendingStart = deferred<BuildIdentity>()
    const readServerBuild = vi.fn().mockReturnValueOnce(pendingStart.promise).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    const started = detector.start()
    const firstPoll = detector.observeStartedAt("t1")
    const secondPoll = detector.observeStartedAt("t2")
    pendingStart.resolve(build("0.22.0"))
    await Promise.all([started, firstPoll, secondPoll])
    await detector.observeStartedAt("t2")
    expect(detector.pageBuildKey()).toBe("0.22.0")
    expect(onServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).toHaveBeenCalledWith(build("0.23.0"), true)
  })

  it("a throwing onServerBuild does not make the read count as failed", async () => {
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    onServerBuild.mockImplementationOnce(() => {
      throw new Error("listener failed")
    })
    await detector.start()
    await detector.observeStartedAt("t1")
    await expect(detector.observeStartedAt("t2")).rejects.toThrow("listener failed")
    await detector.observeStartedAt("t2")
    expect(readServerBuild).toHaveBeenCalledTimes(2)
  })

  it("keeps reporting a new build on later polls without moving the page build", async () => {
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    await detector.observeStartedAt("t2")
    expect(detector.pageBuildKey()).toBe("0.22.0")
    await detector.observeStartedAt("t3")
    expect(detector.pageBuildKey()).toBe("0.22.0")
    expect(onServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).toHaveBeenLastCalledWith(build("0.23.0"), true)
  })

  it("a failed start is retried on the next poll and is never an update", async () => {
    const readServerBuild = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await expect(detector.start()).rejects.toThrow("down")
    expect(detector.pageBuildKey()).toBeNull()
    await detector.observeStartedAt("t1")
    expect(detector.pageBuildKey()).toBe("0.23.0")
    expect(onServerBuild).not.toHaveBeenCalled()
  })

  it("recheck reads the server build without a startedAt change", async () => {
    const readServerBuild = vi.fn().mockResolvedValueOnce(build("0.22.0")).mockResolvedValue(build("0.23.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.recheck()
    expect(readServerBuild).toHaveBeenCalledTimes(2)
    expect(onServerBuild).toHaveBeenCalledWith(build("0.23.0"), true)
  })

  it("ignores a null startedAt", async () => {
    const readServerBuild = vi.fn().mockResolvedValue(build("0.22.0"))
    const { detector, onServerBuild } = setup(readServerBuild)
    await detector.start()
    await detector.observeStartedAt("t1")
    await detector.observeStartedAt(null)
    await detector.observeStartedAt("t1")
    expect(readServerBuild).toHaveBeenCalledTimes(1)
    expect(onServerBuild).not.toHaveBeenCalled()
  })

  it("records when the startedAt last changed", async () => {
    const readServerBuild = vi.fn().mockResolvedValue(build("0.22.0"))
    const clock = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(2000)
    const { detector } = setup(readServerBuild, clock)
    await detector.start()
    expect(detector.lastStartedAtChangeAt()).toBeNull()
    await detector.observeStartedAt("t1")
    expect(detector.lastStartedAtChangeAt()).toBeNull()
    await detector.observeStartedAt("t2")
    expect(detector.lastStartedAtChangeAt()).toBe(1000)
    await detector.observeStartedAt("t2")
    expect(detector.lastStartedAtChangeAt()).toBe(1000)
    await detector.observeStartedAt("t3")
    expect(detector.lastStartedAtChangeAt()).toBe(2000)
  })
})
